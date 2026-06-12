from flask import Flask, render_template, jsonify, request, send_file
from flask_cors import CORS
from datetime import datetime, timedelta
import os
import sys
import threading
import json
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

IS_SERVERLESS = bool(os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))

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

def get_resource_path(relative_path):
    """Get the absolute path to a resource."""
    base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)

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
        
        if IS_SERVERLESS:
            # Serverless: threads die when the response is sent — run synchronously.
            scrape_data()
            cached = typhoons_data.get(request_key, {})
            if cached.get('error'):
                return jsonify({'status': 'error', 'error': cached['error']}), 500
            if not cached.get('typhoons'):
                return jsonify({'status': 'not_found', 'message': 'No typhoons found for this year.'}), 404
            return jsonify({
                'status': 'success',
                'typhoons': cached['typhoons'],
                'earliest_time': cached['earliest_time']
            })

        # Local dev: run in background so the UI stays responsive.
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
    forecast_hour = max(0, min(12, forecast_hour))
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
            'current': 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m',
            'hourly': 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m',
            'forecast_hours': max(1, forecast_hour + 1),
            'timezone': 'auto'
        }
        resp = requests.get(url, params=params, timeout=8)
        resp.raise_for_status()
        payload = resp.json()
        current = payload.get('current', {})
        hourly = payload.get('hourly', {})
        idx_h = forecast_hour
        if forecast_hour <= 0:
            temp = current.get('temperature_2m')
            rain = current.get('precipitation')
            wind_speed = current.get('wind_speed_10m')
            wind_dir = current.get('wind_direction_10m')
        else:
            temp_arr = hourly.get('temperature_2m') or []
            rain_arr = hourly.get('precipitation') or []
            wind_speed_arr = hourly.get('wind_speed_10m') or []
            wind_dir_arr = hourly.get('wind_direction_10m') or []
            temp = temp_arr[idx_h] if idx_h < len(temp_arr) else None
            rain = rain_arr[idx_h] if idx_h < len(rain_arr) else None
            wind_speed = wind_speed_arr[idx_h] if idx_h < len(wind_speed_arr) else None
            wind_dir = wind_dir_arr[idx_h] if idx_h < len(wind_dir_arr) else None
        return {
            'idx': idx,
            'lat': lat,
            'lon': lon,
            'temp': temp,
            'rain': rain,
            'wind_speed': wind_speed,
            'wind_dir': wind_dir
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
                        'idx': idx,
                        'lat': lat, 'lon': lon,
                        'temp': None, 'rain': None, 'wind_speed': None, 'wind_dir': None
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

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)

