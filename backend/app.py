from flask import Flask, render_template, jsonify, request, send_file
from flask_cors import CORS
from datetime import datetime, timedelta
import os
import sys
import threading
import json
import logging
import requests
import re as _re
import xml.etree.ElementTree as _ET
from concurrent.futures import ThreadPoolExecutor, as_completed

logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Add scripts directory to path
scripts_path = os.path.join(os.path.dirname(__file__), 'scripts')
sys.path.insert(0, scripts_path)

# Import typhoon_scraper after path is set
import typhoon_scraper as ty

# Global variables
typhoons_data = {}
loading_status = {}
weather_grid_cache = {}
full_grid_cache = {}   # stores complete 7-day hourly grid, refreshed every 30 min

def get_resource_path(relative_path):
    """Get the absolute path to a resource."""
    base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)


def _wind_to_cat(kt):
    if kt < 34: return 0
    if kt < 64: return 1
    if kt < 96: return 2
    if kt < 113: return 3
    if kt < 137: return 4
    return 5


def _estimate_vel(path_pts, n=6):
    pts = path_pts[-max(2, min(n, len(path_pts))):]
    if len(pts) < 2:
        return {'vLat': 0.04, 'vLon': -0.07}
    vLat = sum(float(pts[i]['lat']) - float(pts[i-1]['lat']) for i in range(1, len(pts))) / (len(pts)-1)
    vLon = sum(
        float(pts[i].get('lon', pts[i].get('long', 0))) -
        float(pts[i-1].get('lon', pts[i-1].get('long', 0)))
        for i in range(1, len(pts))
    ) / (len(pts)-1)
    return {'vLat': round(float(vLat), 4), 'vLon': round(float(vLon), 4)}


def _fetch_live_storms():
    """
    Try PAGASA → JTWC RSS → IBTrACS-recent fallback.
    Returns list of storm dicts or [].
    Each dict: {name, lat, lon, pressure, wind_speed, category, source, path}
    where path is [{lat, lon, pressure, wind_speed}] usable as run_forecast input.
    """
    # 1. PAGASA
    for url in [
        'https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin.json',
        'https://api.pagasa.dost.gov.ph/api/v1/tropical-cyclone/active',
    ]:
        try:
            r = requests.get(url, timeout=10, headers={'User-Agent': 'StormForecastingApp/1.0'})
            r.raise_for_status()
            data = r.json()
            storms = []
            items = data if isinstance(data, list) else data.get('data', data.get('storms', []))
            for item in items:
                lat = float(item.get('lat', item.get('latitude', 0)))
                lon = float(item.get('lon', item.get('longitude', 0)))
                if not (0 <= lat <= 50 and 90 <= lon <= 185): continue
                wind = float(item.get('wind_speed', item.get('max_wind', 35)))
                pres = float(item.get('pressure', item.get('central_pressure', 990)))
                name = str(item.get('name', item.get('ph_name', 'UNNAMED'))).upper()
                storms.append({
                    'name': name, 'lat': lat, 'lon': lon,
                    'pressure': pres, 'wind_speed': wind,
                    'category': _wind_to_cat(wind), 'source': 'PAGASA',
                    'velocity': {'vLat': 0.04, 'vLon': -0.07},
                    'path': [{'lat': lat, 'lon': lon, 'pressure': pres, 'wind_speed': wind}],
                })
            if storms:
                return storms
        except Exception:
            continue

    # 2. JTWC RSS
    try:
        r = requests.get(
            'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss',
            timeout=12, headers={'User-Agent': 'StormForecastingApp/1.0'}
        )
        r.raise_for_status()
        root = _ET.fromstring(r.content)
        storms = []
        for item in root.findall('.//item'):
            title_el = item.find('title')
            desc_el  = item.find('description')
            if title_el is None or desc_el is None: continue
            title = title_el.text or ''
            desc  = desc_el.text  or ''
            pos = _re.search(r'(\d+\.?\d*)\s*N[,\s]+(\d+\.?\d*)\s*E', desc, _re.I)
            if not pos: continue
            lat, lon = float(pos.group(1)), float(pos.group(2))
            if not (0 <= lat <= 50 and 90 <= lon <= 185): continue
            wind = int((_re.search(r'(\d+)\s*KT', desc, _re.I) or [None, '35']).group(1) or 35)
            pres = int((_re.search(r'(\d{3,4})\s*(?:MB|HPA)', desc, _re.I) or [None, '990']).group(1) or 990)
            nm   = _re.search(r'(?:Typhoon|Storm|Depression|Cyclone)\s+(\w+)', title, _re.I)
            name = nm.group(1).upper() if nm else title.split()[0].upper()
            storms.append({
                'name': name, 'lat': lat, 'lon': lon,
                'pressure': pres, 'wind_speed': wind,
                'category': _wind_to_cat(wind), 'source': 'JTWC',
                'velocity': {'vLat': 0.04, 'vLon': -0.07},
                'path': [{'lat': lat, 'lon': lon, 'pressure': pres, 'wind_speed': wind}],
            })
        if storms:
            return storms
    except Exception as ex:
        logger.warning('JTWC fetch failed: %s', ex)

    # 3. IBTrACS fallback — 5 most recent storms from current/last year
    year = datetime.now().year
    for y in [year, year - 1]:
        fp = get_resource_path(f'data/wp_{y}_data.json')
        if not os.path.exists(fp): continue
        try:
            with open(fp) as f:
                data = json.load(f)
        except Exception:
            continue
        storms = []
        for s in data[-5:]:
            if len(s['path']) < 2: continue
            last = s['path'][-1]
            norm = [
                {
                    'lat':        float(p['lat']),
                    'lon':        float(p.get('long', p.get('lon', 130))),
                    'pressure':   float(p.get('pressure', 990)),
                    'wind_speed': float(p.get('speed', p.get('wind_speed', 35))),
                }
                for p in s['path']
            ]
            storms.append({
                'name': s['name'],
                'lat':  float(last['lat']),
                'lon':  float(last.get('long', last.get('lon', 130))),
                'pressure':   float(last.get('pressure', 990)),
                'wind_speed': float(last.get('speed', last.get('wind_speed', 35))),
                'category': _wind_to_cat(float(last.get('speed', last.get('wind_speed', 35)))),
                'source': f'IBTrACS {y}',
                'velocity': _estimate_vel(s['path']),
                'path': norm,
            })
        if storms:
            return storms
    return []


@app.route('/')
def index():
    """Serve the main page."""
    return render_template('index.html')

@app.route('/api/typhoons', methods=['POST'])
def get_typhoons():
    """Fetch typhoon data for a given year and date."""
    data = request.json
    year = data.get('year')
    month = data.get('month', 1)
    day = data.get('day', 1)
    
    try:
        start_date = datetime(year, month, day)
        
        # Check date validity
        if start_date.year < 1951:
            return jsonify({'error': 'Date must be after 1951'}), 400
        
        if start_date.year > datetime.now().year:
            return jsonify({'error': 'Date cannot be in the future'}), 400
        
        # Create a unique key for this request
        request_key = f"{year}_{month}_{day}"
        
        # Check if we're already loading this data
        if request_key in loading_status and loading_status[request_key]:
            return jsonify({'status': 'loading', 'message': 'Data is being loaded...'}), 202
        
        # Check if data is already cached
        if request_key in typhoons_data:
            return jsonify({
                'status': 'success',
                'typhoons': typhoons_data[request_key]['typhoons'],
                'earliest_time': typhoons_data[request_key]['earliest_time']
            })
        
        # Mark as loading
        loading_status[request_key] = True
        
        # Scrape data in background
        def scrape_data():
            try:
                basin_name = "Western Pacific"
                typhoons = ty.scrape_typhoon_data(year, basin_name)
                
                # Filter typhoons by start date
                filtered_typhoons = [
                    typhoon for typhoon in typhoons
                    if datetime.strptime(typhoon['path'][0]['time'], '%Y-%m-%d %H:%M') >= start_date
                ]
                
                if not filtered_typhoons:
                    # Store empty result to prevent re-scraping
                    typhoons_data[request_key] = {
                        'typhoons': [],
                        'earliest_time': None
                    }
                    loading_status[request_key] = False
                    return
                
                # Calculate earliest time
                earliest_time = min(
                    datetime.strptime(point['time'], '%Y-%m-%d %H:%M')
                    for typhoon in filtered_typhoons
                    for point in typhoon['path']
                )
                
                # Set start times relative to earliest time
                TIME_SCALE_FACTOR = 1 / (12 * 60 * 60)  # 1 second per 12 hours
                for typhoon in filtered_typhoons:
                    first_time = datetime.strptime(typhoon['path'][0]['time'], '%Y-%m-%d %H:%M')
                    typhoon['start_time'] = int(((first_time - earliest_time).total_seconds() * TIME_SCALE_FACTOR) * 1000)
                
                # Cache the data
                typhoons_data[request_key] = {
                    'typhoons': filtered_typhoons,
                    'earliest_time': earliest_time.strftime('%Y-%m-%d %H:%M')
                }
            except Exception as e:
                print(f"Error scraping data: {e}")
                import traceback
                traceback.print_exc()
                # Store error state
                typhoons_data[request_key] = {
                    'typhoons': [],
                    'earliest_time': None,
                    'error': str(e)
                }
            finally:
                loading_status[request_key] = False
        
        # Start scraping in background thread
        thread = threading.Thread(target=scrape_data)
        thread.start()
        
        return jsonify({'status': 'loading', 'message': 'Loading typhoon data...'}), 202
        
    except ValueError as e:
        return jsonify({'error': 'Invalid date input'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/typhoons/status', methods=['GET'])
def get_typhoons_status():
    """Check if typhoon data is ready."""
    year = request.args.get('year', type=int)
    month = request.args.get('month', 1, type=int)
    day = request.args.get('day', 1, type=int)
    
    request_key = f"{year}_{month}_{day}"
    
    if request_key in typhoons_data:
        data = typhoons_data[request_key]
        if data.get('error'):
            return jsonify({'status': 'error', 'error': data['error']})
        if not data['typhoons']:
            return jsonify({'status': 'not_found', 'message': 'No typhoons found for this date'})
        return jsonify({
            'status': 'ready',
            'typhoons': data['typhoons'],
            'earliest_time': data['earliest_time']
        })
    elif request_key in loading_status and loading_status[request_key]:
        return jsonify({'status': 'loading'})
    else:
        return jsonify({'status': 'not_found'})

@app.route('/api/map')
def get_map():
    """Serve the detailed map image."""
    map_path = get_resource_path('resources/western_pacific_detailed_map.png')
    if os.path.exists(map_path):
        return send_file(map_path, mimetype='image/png')
    return jsonify({'error': 'Map not found'}), 404

@app.route('/api/map/simple')
def get_simple_map():
    """Serve the simple map image for landfall detection."""
    map_path = get_resource_path('resources/western_pacific_simple_map.png')
    if os.path.exists(map_path):
        return send_file(map_path, mimetype='image/png')
    # Fallback to detailed map if simple map doesn't exist
    map_path = get_resource_path('resources/western_pacific_detailed_map.png')
    if os.path.exists(map_path):
        return send_file(map_path, mimetype='image/png')
    return jsonify({'error': 'Map not found'}), 404

@app.route('/api/weather/grid', methods=['GET'])
def get_weather_grid():
    """Get coarse realtime weather grid for map-wide overlays."""
    region = request.args.get('region', 'par', type=str).lower()
    forecast_hour = request.args.get('forecast_hour', 0, type=int)
    forecast_hour = max(0, min(168, forecast_hour))
    if region == 'par':
        bounds = (115.0, 135.0, 5.0, 25.0)
        nx, ny = 12, 8
    else:
        bounds = (100.0, 180.0, 0.0, 60.0)
        nx, ny = 14, 10

    now_bucket = int(datetime.utcnow().timestamp() // 600)  # cache per 10 minutes
    cache_key = f"{region}_{nx}_{ny}_{forecast_hour}_{now_bucket}"
    cached = weather_grid_cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    min_lon, max_lon, min_lat, max_lat = bounds
    lon_step = (max_lon - min_lon) / (nx - 1)
    lat_step = (max_lat - min_lat) / (ny - 1)
    points = []
    for yi in range(ny):
        for xi in range(nx):
            idx = yi * nx + xi
            points.append((idx, min_lat + yi * lat_step, min_lon + xi * lon_step))

    def fetch_point(idx, lat, lon):
        url = 'https://api.open-meteo.com/v1/forecast'
        params = {
            'latitude': round(lat, 3),
            'longitude': round(lon, 3),
            'current': 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover',
            'hourly': 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover',
            'forecast_hours': max(1, forecast_hour + 1),
            'timezone': 'UTC'
        }
        resp = requests.get(url, params=params, timeout=8)
        resp.raise_for_status()
        payload = resp.json()
        current = payload.get('current', {})
        hourly  = payload.get('hourly', {})
        if forecast_hour <= 0:
            temp       = current.get('temperature_2m')
            heat       = current.get('apparent_temperature')
            rain       = current.get('precipitation')
            wind_speed = current.get('wind_speed_10m')
            wind_dir   = current.get('wind_direction_10m')
            cloud      = current.get('cloud_cover')
        else:
            def _h(key):
                arr = hourly.get(key) or []
                return arr[forecast_hour] if forecast_hour < len(arr) else None
            temp       = _h('temperature_2m')
            heat       = _h('apparent_temperature')
            rain       = _h('precipitation')
            wind_speed = _h('wind_speed_10m')
            wind_dir   = _h('wind_direction_10m')
            cloud      = _h('cloud_cover')
        return {
            'idx': idx, 'lat': lat, 'lon': lon,
            'temp': temp, 'heat': heat, 'rain': rain,
            'wind_speed': wind_speed, 'wind_dir': wind_dir, 'cloud': cloud,
        }

    values = []
    try:
        with ThreadPoolExecutor(max_workers=8) as ex:
            future_map = {ex.submit(fetch_point, idx, lat, lon): (idx, lat, lon) for idx, lat, lon in points}
            for fut in as_completed(future_map):
                try:
                    values.append(fut.result())
                except Exception:
                    idx, lat, lon = future_map[fut]
                    values.append({
                        'idx': idx, 'lat': lat, 'lon': lon,
                        'temp': None, 'heat': None, 'rain': None,
                        'wind_speed': None, 'wind_dir': None, 'cloud': None,
                    })
    except Exception as e:
        return jsonify({'error': f'Grid weather fetch failed: {str(e)}'}), 502

    values.sort(key=lambda v: v.get('idx', 0))

    payload = {
        'status': 'success',
        'provider': 'open-meteo',
        'mode': 'realtime_forecast',
        'forecast_hour': forecast_hour,
        'generated_at_utc': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'region': region,
        'bounds': {
            'min_lon': min_lon, 'max_lon': max_lon,
            'min_lat': min_lat, 'max_lat': max_lat
        },
        'nx': nx,
        'ny': ny,
        'points': values
    }
    weather_grid_cache.clear()
    weather_grid_cache[cache_key] = payload
    return jsonify(payload)

@app.route('/api/weather/realtime', methods=['GET'])
def get_realtime_weather():
    """Get realtime weather and short hourly forecast from Open-Meteo."""
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)

    if lat is None or lon is None:
        return jsonify({'error': 'lat and lon are required'}), 400
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        return jsonify({'error': 'Invalid lat/lon range'}), 400

    try:
        url = 'https://api.open-meteo.com/v1/forecast'
        params = {
            'latitude': lat,
            'longitude': lon,
            'current': 'temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
            'hourly': 'temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_direction_10m',
            'forecast_hours': 12,
            'timezone': 'auto'
        }
        resp = requests.get(url, params=params, timeout=12)
        resp.raise_for_status()
        data = resp.json()

        return jsonify({
            'status': 'success',
            'lat': lat,
            'lon': lon,
            'timezone': data.get('timezone'),
            'current': data.get('current', {}),
            'hourly': data.get('hourly', {})
        })
    except requests.exceptions.RequestException as e:
        return jsonify({'error': f'Weather provider request failed: {str(e)}'}), 502
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/storms/list', methods=['GET'])
def list_storms():
    """Return all storm names available for a given year from the local IBTrACS JSON."""
    year = request.args.get('year', type=int)
    if not year:
        return jsonify({'error': 'year is required'}), 400

    data_path = get_resource_path(f'data/wp_{year}_data.json')
    if not os.path.exists(data_path):
        return jsonify({'error': f'No data file for year {year}'}), 404

    try:
        with open(data_path, 'r') as f:
            storms = json.load(f)
        names = [{'name': s['name'], 'points': len(s['path'])} for s in storms]
        return jsonify({'status': 'success', 'year': year, 'storms': names})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/forecast/from-storm', methods=['POST'])
def forecast_from_storm():
    """
    Build a 7-day AI/physics forecast directly from a historical IBTrACS storm.

    Request body
    ------------
    { "year": 2024, "storm_name": "CARINA", "history_hours": 48 }

    history_hours – how many hours of the storm's observed track to use as
                    input context (default 48, i.e. last 16 × 3-h points).
    The last `history_hours` of the storm's actual track become the forecast
    input; the returned forecast then continues from that endpoint.
    """
    payload = request.get_json(silent=True) or {}
    year        = payload.get('year')
    storm_name  = str(payload.get('storm_name', '')).upper().strip()
    history_hrs = int(payload.get('history_hours', 48))

    if not year or not storm_name:
        return jsonify({'error': 'year and storm_name are required'}), 400

    data_path = get_resource_path(f'data/wp_{year}_data.json')
    if not os.path.exists(data_path):
        return jsonify({'error': f'No IBTrACS data for year {year}'}), 404

    try:
        with open(data_path, 'r') as f:
            all_storms = json.load(f)
    except Exception as e:
        return jsonify({'error': f'Could not read data file: {e}'}), 500

    storm = next((s for s in all_storms
                  if s['name'].upper() == storm_name), None)
    if storm is None:
        available = [s['name'] for s in all_storms]
        return jsonify({'error': f'Storm "{storm_name}" not found in {year}',
                        'available': available}), 404

    path = storm['path']
    if len(path) < 2:
        return jsonify({'error': 'Storm has fewer than 2 track points'}), 400

    # IBTrACS path points are 3-hourly; estimate how many to use as history
    step_hours = 3
    history_steps = max(2, history_hrs // step_hours)
    track_history = [
        {
            'lat':        float(p['lat']),
            'lon':        float(p.get('long', p.get('lon', 0))),
            'pressure':   float(p.get('pressure', 1000)),
            'wind_speed': float(p.get('speed', p.get('wind_speed', 35))),
        }
        for p in path[-history_steps:]
    ]

    try:
        from scripts.ai_models import run_forecast
        result = run_forecast(track_history)
    except Exception as exc:
        import traceback
        logger.error("Forecast error: %s\n%s", exc, traceback.format_exc())
        return jsonify({'error': f'Forecast failed: {exc}'}), 500

    # Also return the full observed track for display
    full_track = [
        {
            'lat':        float(p['lat']),
            'lon':        float(p.get('long', p.get('lon', 0))),
            'pressure':   float(p.get('pressure', 1000)),
            'wind_speed': float(p.get('speed', p.get('wind_speed', 35))),
            'time':       p.get('time', ''),
            'class':      p.get('class', 0),
        }
        for p in path
    ]

    return jsonify({
        'status':           'success',
        'storm_name':       storm['name'],
        'year':             year,
        'grid':             result['grid'],
        'forecast_steps':   result['forecast_steps'],
        'track_history':    track_history,
        'full_observed_track': full_track,
        'method':           result.get('method', 'physics'),
        'generated_at_utc': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'step_hours':       3,
        'total_hours':      168,
    })


@app.route('/forecast')
def forecast_page():
    """Serve the 7-day AI typhoon forecasting dashboard."""
    return render_template('forecast.html')


@app.route('/api/forecast', methods=['POST'])
def run_ai_forecast():
    """
    Run the 7-day LSTM + Random Forest typhoon forecast.

    Request body (JSON)
    -------------------
    {
      "storm_name":    "CARINA",          // optional display name
      "track_history": [                  // required; >= 2 points
        {"lat": 8.5, "lon": 130.2, "pressure": 998, "wind_speed": 45},
        ...
      ]
    }

    Response (JSON)
    ---------------
    {
      "status":      "success",
      "storm_name":  "CARINA",
      "grid": {
        "lats": [[5.0, ...], ...],        // fixed 20x20 PAR grid (returned once)
        "lons": [[115.0, ...], ...]
      },
      "forecast_steps": [
        {
          "hour": 3, "lat": ..., "lon": ..., "pressure": ..., "wind_speed": ...,
          "u": [[...], ...],              // 20x20 zonal wind (m/s)
          "v": [[...], ...]               // 20x20 meridional wind (m/s)
        },
        ...                              // 56 steps total (168 h)
      ],
      "track_history":   [...],
      "generated_at_utc": "..."
    }
    """
    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({'error': 'JSON body required'}), 400

    track_history = payload.get('track_history')
    if not track_history or not isinstance(track_history, list):
        return jsonify({'error': 'track_history must be a non-empty array'}), 400

    if len(track_history) < 2:
        return jsonify({'error': 'track_history must contain at least 2 points'}), 400

    required_keys = {'lat', 'lon', 'pressure', 'wind_speed'}
    for i, pt in enumerate(track_history):
        missing = required_keys - set(pt.keys())
        if missing:
            return jsonify({
                'error': f'track_history[{i}] missing fields: {sorted(missing)}'
            }), 400
        for k in required_keys:
            try:
                float(pt[k])
            except (TypeError, ValueError):
                return jsonify({
                    'error': f'track_history[{i}].{k} is not a number'
                }), 400

    storm_name = str(payload.get('storm_name', 'UNNAMED')).upper()[:32]

    try:
        from scripts.ai_models import run_forecast
        result = run_forecast(track_history)
    except RuntimeError as exc:
        return jsonify({'error': str(exc), 'hint': 'Check that model files exist in models/'}), 503
    except Exception as exc:
        import traceback
        logger.error("Forecast error: %s\n%s", exc, traceback.format_exc())
        return jsonify({'error': f'Inference failed: {exc}'}), 500

    return jsonify({
        'status':           'success',
        'storm_name':       storm_name,
        'grid':             result['grid'],
        'forecast_steps':   result['forecast_steps'],
        'track_history':    track_history,
        'method':           result.get('method', 'physics'),
        'generated_at_utc': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'step_hours':       3,
        'total_hours':      168,
    })


@app.route('/api/realtime-storms', methods=['GET'])
def get_realtime_storms():
    """
    Fetch active WP tropical cyclones.
    Tries PAGASA bulletin → JTWC RSS → IBTrACS fallback.
    """
    def _wind_to_cat(kt):
        if kt < 34: return 0
        if kt < 64: return 1
        if kt < 96: return 2
        if kt < 113: return 3
        if kt < 137: return 4
        return 5

    def _estimate_vel(path_pts, n=6):
        pts = path_pts[-max(2, min(n, len(path_pts))):]
        if len(pts) < 2:
            return {'vLat': 0.04, 'vLon': -0.07}
        vLat = sum(float(pts[i]['lat']) - float(pts[i-1]['lat']) for i in range(1, len(pts))) / (len(pts)-1)
        vLon = sum(float(pts[i].get('lon', pts[i].get('long', 0))) - float(pts[i-1].get('lon', pts[i-1].get('long', 0))) for i in range(1, len(pts))) / (len(pts)-1)
        return {'vLat': round(float(vLat), 4), 'vLon': round(float(vLon), 4)}

    def try_pagasa():
        """Try PAGASA open data endpoints for active PAR typhoons."""
        endpoints = [
            'https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin.json',
            'https://api.pagasa.dost.gov.ph/api/v1/tropical-cyclone/active',
        ]
        for url in endpoints:
            try:
                r = requests.get(url, timeout=10, headers={'User-Agent': 'StormForecastingApp/1.0'})
                r.raise_for_status()
                data = r.json()
                storms = []
                items = data if isinstance(data, list) else data.get('data', data.get('storms', []))
                for item in items:
                    lat = float(item.get('lat', item.get('latitude', 0)))
                    lon = float(item.get('lon', item.get('longitude', 0)))
                    if not (0 <= lat <= 50 and 90 <= lon <= 185): continue
                    wind = float(item.get('wind_speed', item.get('max_wind', 35)))
                    pres = float(item.get('pressure', item.get('central_pressure', 990)))
                    name = str(item.get('name', item.get('ph_name', 'UNNAMED'))).upper()
                    storms.append({
                        'name': name, 'lat': lat, 'lon': lon,
                        'pressure': pres, 'wind_speed': wind,
                        'category': _wind_to_cat(wind), 'source': 'PAGASA',
                        'velocity': {'vLat': 0.04, 'vLon': -0.07},
                        'path': [{'lat': lat, 'lon': lon, 'pressure': pres, 'wind_speed': wind}],
                    })
                if storms:
                    return storms
            except Exception:
                continue
        return []

    def try_jtwc():
        """Parse JTWC RSS feed – covers all WP tropical cyclones."""
        try:
            r = requests.get(
                'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss',
                timeout=12, headers={'User-Agent': 'StormForecastingApp/1.0'}
            )
            r.raise_for_status()
            root = _ET.fromstring(r.content)
            storms = []
            for item in root.findall('.//item'):
                title_el = item.find('title')
                desc_el  = item.find('description')
                if title_el is None or desc_el is None: continue
                title = title_el.text or ''
                desc  = desc_el.text  or ''
                # Position: "12.5N 140.0E"
                pos = _re.search(r'(\d+\.?\d*)\s*N[,\s]+(\d+\.?\d*)\s*E', desc, _re.I)
                if not pos: continue
                lat, lon = float(pos.group(1)), float(pos.group(2))
                if not (0 <= lat <= 50 and 90 <= lon <= 185): continue
                wind = int((_re.search(r'(\d+)\s*KT', desc, _re.I) or [None,'35']).group(1) or 35)
                pres = int((_re.search(r'(\d{3,4})\s*(?:MB|HPA)', desc, _re.I) or [None,'990']).group(1) or 990)
                nm   = _re.search(r'(?:Typhoon|Storm|Depression|Cyclone)\s+(\w+)', title, _re.I)
                name = nm.group(1).upper() if nm else title.split()[0].upper()
                storms.append({
                    'name': name, 'lat': lat, 'lon': lon,
                    'pressure': pres, 'wind_speed': wind,
                    'category': _wind_to_cat(wind), 'source': 'PAGASA / JTWC',
                    'velocity': {'vLat': 0.04, 'vLon': -0.07},
                    'path': [{'lat': lat, 'lon': lon, 'pressure': pres, 'wind_speed': wind}],
                })
            return storms
        except Exception as ex:
            logger.warning('JTWC fetch failed: %s', ex)
            return []

    def ibtracs_fallback():
        year = datetime.now().year
        for y in [year, year - 1]:
            fp = get_resource_path(f'data/wp_{y}_data.json')
            if not os.path.exists(fp): continue
            with open(fp) as f:
                data = json.load(f)
            storms = []
            for s in data[-5:]:
                if len(s['path']) < 2: continue
                last = s['path'][-1]
                norm = [{'lat': float(p['lat']),
                         'lon': float(p.get('long', p.get('lon', 130))),
                         'pressure': float(p.get('pressure', 990)),
                         'wind_speed': float(p.get('speed', p.get('wind_speed', 35)))}
                        for p in s['path']]
                storms.append({
                    'name': s['name'],
                    'lat':  float(last['lat']),
                    'lon':  float(last.get('long', last.get('lon', 130))),
                    'pressure':   float(last.get('pressure', 990)),
                    'wind_speed': float(last.get('speed', last.get('wind_speed', 35))),
                    'category': int(last.get('class', 1)),
                    'source': f'IBTrACS {y} (historical fallback)',
                    'velocity': _estimate_vel(s['path']),
                    'path': norm,
                })
            if storms:
                return storms
        return []

    storms = try_pagasa()
    if not storms:
        storms = try_jtwc()
    if not storms:
        storms = ibtracs_fallback()

    source = storms[0]['source'] if storms else 'none'
    return jsonify({
        'status': 'success', 'source': source,
        'count': len(storms), 'storms': storms,
        'generated_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    })


@app.route('/api/storm/track', methods=['GET'])
def get_storm_track():
    """Return the full track for a single storm (lat/lon normalized)."""
    year = request.args.get('year', type=int)
    name = request.args.get('name', '').upper().strip()
    if not year or not name:
        return jsonify({'error': 'year and name are required'}), 400
    data_path = get_resource_path(f'data/wp_{year}_data.json')
    if not os.path.exists(data_path):
        return jsonify({'error': f'No data for {year}'}), 404
    try:
        with open(data_path, 'r') as f:
            storms = json.load(f)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    storm = next((s for s in storms if s['name'].upper() == name), None)
    if not storm:
        return jsonify({'error': f'{name} not found in {year}'}), 404
    path = [{
        'time':       p.get('time', ''),
        'lat':        float(p['lat']),
        'lon':        float(p.get('long', p.get('lon', 0))),
        'pressure':   float(p.get('pressure', 1000)),
        'wind_speed': float(p.get('speed', p.get('wind_speed', 35))),
        'category':   int(p.get('class', 0)),
    } for p in storm['path']]
    return jsonify({'status': 'success', 'name': storm['name'], 'year': year, 'path': path})


@app.route('/api/storm/year-tracks', methods=['GET'])
def get_year_tracks():
    """Return simplified (lat/lon only) tracks for all storms in a year."""
    year = request.args.get('year', type=int)
    if not year:
        return jsonify({'error': 'year is required'}), 400
    data_path = get_resource_path(f'data/wp_{year}_data.json')
    if not os.path.exists(data_path):
        return jsonify({'error': f'No data for {year}'}), 404
    try:
        with open(data_path, 'r') as f:
            storms = json.load(f)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    result = []
    for s in storms:
        latlons = [[float(p['lat']), float(p.get('long', p.get('lon', 0)))] for p in s['path']]
        peak_cat = max((int(p.get('class', 0)) for p in s['path']), default=0)
        result.append({'name': s['name'], 'path': latlons, 'peak_category': peak_cat})
    return jsonify({'status': 'success', 'year': year, 'storms': result})


@app.route('/api/weather/marine', methods=['GET'])
def get_marine_grid():
    """Wave height data from Open-Meteo marine API for PAR ocean grid."""
    forecast_hour = request.args.get('forecast_hour', 0, type=int)
    forecast_hour = max(0, min(168, forecast_hour))
    nx, ny = 8, 6
    min_lon, max_lon, min_lat, max_lat = 115.0, 135.0, 5.0, 25.0
    points = []
    for yi in range(ny):
        for xi in range(nx):
            lat = round(min_lat + yi * (max_lat - min_lat) / (ny - 1), 2)
            lon = round(min_lon + xi * (max_lon - min_lon) / (nx - 1), 2)
            points.append((yi * nx + xi, lat, lon))

    def fetch_marine(idx, lat, lon):
        try:
            resp = requests.get(
                'https://marine-api.open-meteo.com/v1/marine',
                params={
                    'latitude': lat, 'longitude': lon,
                    'hourly': 'wave_height,wave_direction,wave_period',
                    'forecast_days': 7, 'timezone': 'UTC',
                },
                timeout=8,
            )
            if resp.status_code != 200:
                return None
            data = resp.json()
            h_arr = data.get('hourly', {}).get('wave_height') or []
            d_arr = data.get('hourly', {}).get('wave_direction') or []
            p_arr = data.get('hourly', {}).get('wave_period') or []
            h_idx = min(forecast_hour, len(h_arr) - 1)
            if h_idx < 0 or h_arr[h_idx] is None:
                return None
            return {
                'idx': idx, 'lat': lat, 'lon': lon,
                'wave_height':    h_arr[h_idx],
                'wave_direction': d_arr[h_idx] if h_idx < len(d_arr) else None,
                'wave_period':    p_arr[h_idx] if h_idx < len(p_arr) else None,
            }
        except Exception:
            return None

    results = []
    try:
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = {ex.submit(fetch_marine, idx, lat, lon): idx for idx, lat, lon in points}
            for fut in as_completed(futs):
                r = fut.result()
                if r:
                    results.append(r)
    except Exception as e:
        return jsonify({'error': f'Marine fetch failed: {e}'}), 502

    results.sort(key=lambda x: x['idx'])
    return jsonify({
        'status': 'success',
        'provider': 'open-meteo-marine',
        'forecast_hour': forecast_hour,
        'generated_at_utc': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'count': len(results),
        'points': results,
    })


@app.route('/api/climate/outlook', methods=['GET'])
def get_climate_outlook():
    """
    Climatological seasonal outlook using historical IBTrACS data (2013-2025).
    For any target month/year, analyzes past typhoon tracks to predict expected
    activity level, track corridors, and peak storm areas.
    """
    MONTH_NAMES = ['','January','February','March','April','May','June',
                   'July','August','September','October','November','December']

    month = request.args.get('month', type=int) or datetime.utcnow().month
    year  = request.args.get('year',  type=int) or datetime.utcnow().year
    month = max(1, min(12, month))

    data_dir = get_resource_path('data')
    all_tracks_in_month = []
    per_year_counts = {}
    years_with_data  = []

    for yr in range(2013, 2026):
        path = os.path.join(data_dir, f'wp_{yr}_data.json')
        if not os.path.exists(path):
            continue
        try:
            with open(path, 'r') as f:
                storms = json.load(f)
        except Exception:
            continue
        years_with_data.append(yr)
        count = 0
        for s in storms:
            pts = []
            for p in s.get('path', []):
                t = p.get('time', '')
                try:
                    dt = datetime.strptime(t, '%Y-%m-%d %H:%M')
                    if dt.month == month:
                        pts.append({
                            'lat': float(p['lat']),
                            'lon': float(p.get('long', p.get('lon', 0))),
                            'cat': int(p.get('class', 0)),
                        })
                except Exception:
                    continue
            if pts:
                all_tracks_in_month.append({'name': s.get('name','UNNAMED'), 'year': yr,
                                            'peak_cat': max(p['cat'] for p in pts), 'points': pts})
                count += 1
        per_year_counts[yr] = count

    if not years_with_data:
        return jsonify({'error': 'No historical data available'}), 404

    # Build 20×20 track density grid (fraction of years a storm passed each cell)
    GRID_N = 20
    lat_min, lat_max, lon_min, lon_max = 5.0, 25.0, 115.0, 135.0
    density = [[0.0]*GRID_N for _ in range(GRID_N)]
    n_years = len(years_with_data)

    for storm in all_tracks_in_month:
        visited = set()
        for p in storm['points']:
            i = round((p['lat']-lat_min)/(lat_max-lat_min)*(GRID_N-1))
            j = round((p['lon']-lon_min)/(lon_max-lon_min)*(GRID_N-1))
            i, j = max(0,min(GRID_N-1,i)), max(0,min(GRID_N-1,j))
            if (i,j) not in visited:
                density[i][j] += 1.0/n_years
                visited.add((i,j))

    max_d = max(density[i][j] for i in range(GRID_N) for j in range(GRID_N)) or 1
    grid_pts = []
    for i in range(GRID_N):
        for j in range(GRID_N):
            grid_pts.append({
                'lat': round(lat_min + i/(GRID_N-1)*(lat_max-lat_min), 2),
                'lon': round(lon_min + j/(GRID_N-1)*(lon_max-lon_min), 2),
                'density': round(density[i][j]/max_d, 3),
            })

    counts    = list(per_year_counts.values())
    avg_count = round(sum(counts)/len(counts), 1)
    max_count = max(counts)
    max_yr    = max(per_year_counts, key=per_year_counts.get)
    analogs   = sorted([(yr,c) for yr,c in per_year_counts.items() if c>0],
                       key=lambda x: x[1], reverse=True)[:3]

    if avg_count < 0.5:   activity = 'quiet'
    elif avg_count < 1.5: activity = 'below-normal'
    elif avg_count < 3.0: activity = 'normal'
    elif avg_count < 4.5: activity = 'above-normal'
    else:                  activity = 'very active'

    mon = MONTH_NAMES[month]
    if month in [6,7,8,9,10]:
        season_note = f'{mon} is in the peak typhoon season — expect heightened activity.'
    elif month in [11,12]:
        season_note = f'{mon} sees declining but still significant typhoon activity.'
    elif month in [1,2,3]:
        season_note = f'{mon} is the off-season — typhoon formation is rare but possible.'
    else:
        season_note = f'{mon} marks the start of the pre-season — activity is building.'

    forecast_text = (
        f"{mon} {year} Seasonal Outlook\n"
        f"Based on {n_years} years of historical data (2013–{max(years_with_data)}), "
        f"the PAR region typically sees {avg_count} tropical cyclones in {mon}. "
        f"The most active {mon} was {max_yr} with {max_count} storms. "
        f"Expected activity: {activity.upper()}. {season_note}"
    )

    return jsonify({
        'status':         'success',
        'month':          month,
        'month_name':     mon,
        'target_year':    year,
        'n_years':        n_years,
        'avg_storms':     avg_count,
        'max_storms':     max_count,
        'max_year':       max_yr,
        'activity_level': activity,
        'per_year_counts': per_year_counts,
        'analogs':        [{'year': yr, 'storms': c} for yr,c in analogs],
        'forecast_text':  forecast_text,
        'track_density':  grid_pts,
        'historical_tracks': [
            {'name': s['name'], 'year': s['year'], 'peak_cat': s['peak_cat'],
             'points': s['points']}
            for s in all_tracks_in_month
        ],
    })


@app.route('/api/forecast/smart', methods=['POST'])
def forecast_smart():
    """
    Smart 7-day typhoon forecast with auto data-source selection.

    Priority:
      1. use_live=true → tries PAGASA / JTWC RSS → picks first active WP storm
      2. track_history provided in body → uses it directly
      3. Physics engine always runs as final fallback (no ML files needed)

    Request body (JSON):
    {
        "storm_name":    "CARINA",          // optional display name
        "track_history": [                  // required when use_live=false; >= 2 points
            {"lat": 8.5, "lon": 130.2, "pressure": 998, "wind_speed": 45},
            ...
        ],
        "use_live": false                   // set true to fetch an active storm first
    }

    Response:
    {
        "status": "success",
        "storm_name": "CARINA",
        "source": "track_history" | "PAGASA" | "JTWC" | "IBTrACS <year>",
        "method": "physics" | "lstm+rf",
        "forecast_steps": [{hour, lat, lon, pressure, wind_speed, u, v}, ...],
        "grid": {lats, lons},
        "track_history": [...],
        "generated_at_utc": "..."
    }
    """
    payload      = request.get_json(silent=True) or {}
    storm_name   = str(payload.get('storm_name', 'UNNAMED')).upper()[:32]
    track_history = payload.get('track_history') or []
    use_live      = bool(payload.get('use_live', False))
    source        = 'track_history'

    # Step 1 — optionally try live sources first
    if use_live:
        live_storms = _fetch_live_storms()
        if live_storms:
            best = max(live_storms, key=lambda s: s.get('wind_speed', 0))
            storm_name    = best['name']
            track_history = best['path']
            source        = best['source']

    # Step 2 — validate we have something to forecast with
    if not track_history or len(track_history) < 2:
        return jsonify({
            'error': (
                'track_history must contain >= 2 points. '
                'Provide track_history in the body or set use_live=true.'
            )
        }), 400

    # Step 3 — normalise keys (frontend sends windSpeed; API expects wind_speed)
    normalized = []
    for p in track_history:
        normalized.append({
            'lat':        float(p.get('lat', 0)),
            'lon':        float(p.get('lon', p.get('long', 130))),
            'pressure':   float(p.get('pressure', 990)),
            'wind_speed': float(p.get('wind_speed', p.get('windSpeed', 35))),
        })

    # Step 4 — run forecast (physics if no ML models; ML if models/ has the files)
    try:
        from scripts.ai_models import run_forecast
        result = run_forecast(normalized)
    except Exception as exc:
        import traceback
        logger.error('Smart forecast error: %s\n%s', exc, traceback.format_exc())
        return jsonify({'error': f'Forecast engine failed: {exc}'}), 500

    return jsonify({
        'status':           'success',
        'storm_name':       storm_name,
        'source':           source,
        'method':           result.get('method', 'physics'),
        'forecast_steps':   result['forecast_steps'],
        'grid':             result['grid'],
        'track_history':    normalized,
        'generated_at_utc': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'step_hours':       3,
        'total_hours':      168,
    })


@app.route('/api/weather/fullgrid', methods=['GET'])
def get_full_weather_grid():
    """
    Fetch the complete 7-day hourly forecast for every grid point in one shot.
    Returns 168 values per variable per point so the frontend can switch between
    forecast hours instantly without additional API calls.
    Cached for 30 minutes (one bucket = 1800 s).
    """
    region = request.args.get('region', 'par', type=str).lower()

    if region == 'par':
        bounds = (115.0, 135.0, 5.0, 25.0)
        nx, ny = 12, 8
    else:
        bounds = (100.0, 180.0, 0.0, 60.0)
        nx, ny = 14, 10

    now_bucket = int(datetime.utcnow().timestamp() // 1800)
    cache_key  = f"full_{region}_{now_bucket}"
    cached     = full_grid_cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    min_lon, max_lon, min_lat, max_lat = bounds
    points = []
    for yi in range(ny):
        for xi in range(nx):
            lat = round(min_lat + yi * (max_lat - min_lat) / (ny - 1), 3)
            lon = round(min_lon + xi * (max_lon - min_lon) / (nx - 1), 3)
            points.append((yi * nx + xi, lat, lon))

    def fetch_full_point(idx, lat, lon):
        try:
            resp = requests.get(
                'https://api.open-meteo.com/v1/forecast',
                params={
                    'latitude':  lat,
                    'longitude': lon,
                    'hourly': ','.join([
                        'temperature_2m', 'apparent_temperature',
                        'precipitation', 'wind_speed_10m',
                        'wind_direction_10m', 'cloud_cover',
                    ]),
                    'forecast_days': 7,
                    'timezone': 'UTC',
                },
                timeout=15,
            )
            resp.raise_for_status()
            h = resp.json().get('hourly', {})
            return {
                'idx':        idx, 'lat': lat, 'lon': lon,
                'temp':       h.get('temperature_2m',      []),
                'heat':       h.get('apparent_temperature', []),
                'precip':     h.get('precipitation',        []),
                'wind_speed': h.get('wind_speed_10m',       []),
                'wind_dir':   h.get('wind_direction_10m',   []),
                'cloud':      h.get('cloud_cover',          []),
            }
        except Exception:
            return {
                'idx': idx, 'lat': lat, 'lon': lon,
                'temp': [], 'heat': [], 'precip': [],
                'wind_speed': [], 'wind_dir': [], 'cloud': [],
            }

    results = []
    try:
        with ThreadPoolExecutor(max_workers=16) as ex:
            futs = {ex.submit(fetch_full_point, idx, lat, lon): idx
                    for idx, lat, lon in points}
            for fut in as_completed(futs):
                results.append(fut.result())
    except Exception as e:
        return jsonify({'error': f'Full-grid fetch failed: {e}'}), 502

    results.sort(key=lambda x: x['idx'])

    payload = {
        'status':           'success',
        'provider':         'open-meteo',
        'region':           region,
        'nx':               nx,
        'ny':               ny,
        'n_hours':          168,
        'step_hours':       1,
        'generated_at_utc': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'points':           results,
    }
    full_grid_cache.clear()
    full_grid_cache[cache_key] = payload
    return jsonify(payload)


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)

