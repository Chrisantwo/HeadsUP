/* ============================================================
   STORM FORECASTING  –  Real-Time PAR Dashboard  v8
   Always-on 7-day date timeline · Smooth weather overlays
   Rain radar · Cloud cover · Heat index · Wave height · Wind
   ============================================================ */
'use strict';

// ── Constants ──────────────────────────────────────────────
const PAR       = { latMin:5, latMax:25, lonMin:115, lonMax:135 };
const GRID_N    = 20;
const N_PART    = 2000;
const MAX_AGE   = 200;
const SPD_SCALE = 0.006;
const FADE      = 0.04;
const PLAY_MS   = 450;
const ENSEMBLE_N = 9;

const CAT_COLOR = ['#87ceeb','#64ee64','#e1e100','#ff8200','#ff0000','#ff00ff'];
const CAT_LABEL = ['TD','TS','TY','STY3','STY4','STY5'];
const CAT_NAME  = ['Tropical Depression','Tropical Storm','Typhoon (Cat 1-2)',
                   'Severe Typhoon (Cat 3)','Super Typhoon (Cat 4)','Super Typhoon (Cat 5)'];

const TILE_URLS = {
    satellite: {
        url:  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attr: '© Esri, Maxar, GeoEye, Earthstar Geographics',
        maxZoom: 17,
    },
    terrain: {
        url:  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        attr: '© Esri', maxZoom: 17,
    },
    dark: {
        url:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attr: '© CARTO', maxZoom: 19, subdomains: 'abcd',
    },
};

// ── App State ──────────────────────────────────────────────
const S = {
    year: 2024,
    stormList: [],
    activeStorm: null,
    forecast: null,
    mode: 'idle',         // 'idle' | 'historical' | 'forecast'
    histStep: 0,
    fcstStep: 0,
    isPlaying: false,
    playTimer: null,

    // Timeline
    tlBaseTime: null,
    forecastHour: 0,      // 0-168, drives weather layer for current timeline position

    // Leaflet layers
    baseTile: null,
    bgGroup: null,
    activeGroup: null,
    fcstGroup: null,
    ensembleGroup: null,
    stormMarker: null,

    // Weather layers
    windEngine: null,
    showWind: true,
    rainLayer: null,
    rainFrames: [],

    // Shared overlay canvas
    tempCanvasActive: false,
    overlayType: null,    // 'temp' | 'heat' | 'cloud' | 'wave'
    tempPoints: null,
    cloudPoints: null,
    wavePoints: null,

    currentMapType: 'satellite',
};

let _map;

// ── Map Initialization ─────────────────────────────────────
function initMap() {
    _map = L.map('map', {
        center: [13, 122.5], zoom: 5,
        preferCanvas: true, zoomControl: false, attributionControl: false,
    });
    _switchBaseTile('satellite');
    L.control.zoom({ position: 'bottomright' }).addTo(_map);
    L.control.attribution({ position: 'bottomright', prefix: false }).addTo(_map);
    L.rectangle([[PAR.latMin, PAR.lonMin],[PAR.latMax, PAR.lonMax]], {
        color:'#0052cc', weight:1.5, opacity:0.35, fill:false,
        dashArray:'7,10', interactive:false,
    }).addTo(_map);

    S.bgGroup       = L.layerGroup().addTo(_map);
    S.fcstGroup     = L.layerGroup().addTo(_map);
    S.ensembleGroup = L.layerGroup().addTo(_map);

    _map.on('movestart zoomstart', () => {
        if (S.windEngine) S.windEngine.clearTrails();
        if (S.tempCanvasActive) {
            const c = document.getElementById('temp-canvas');
            c.getContext('2d').clearRect(0, 0, c.width, c.height);
        }
    });
    _map.on('moveend zoomend', () => {
        if (S.tempCanvasActive) _redrawOverlay();
    });
}

function _switchBaseTile(type) {
    if (S.baseTile) _map.removeLayer(S.baseTile);
    const cfg = TILE_URLS[type] || TILE_URLS.satellite;
    S.baseTile = L.tileLayer(cfg.url, {
        attribution: cfg.attr, maxZoom: cfg.maxZoom || 17,
        subdomains: cfg.subdomains || 'abc',
    }).addTo(_map);
    S.currentMapType = type;
    document.querySelectorAll('.map-type-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.map === type));
}

// ── Wind Canvas ────────────────────────────────────────────
let _windCanvas;
function initWindCanvas() {
    _windCanvas = document.getElementById('wind-canvas');
    const cont  = _map.getContainer();
    cont.appendChild(_windCanvas);
    Object.assign(_windCanvas.style, {
        position:'absolute', top:'0', left:'0',
        width:'100%', height:'100%', pointerEvents:'none', zIndex:'201',
    });
    function resize() { _windCanvas.width = cont.clientWidth; _windCanvas.height = cont.clientHeight; }
    resize(); window.addEventListener('resize', resize);
    S.windEngine = new WindEngine(_map, _windCanvas);
}

// ── Wind Particle Engine ───────────────────────────────────
class WindEngine {
    constructor(mapRef, canvas) {
        this.map = mapRef; this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.grid = null; this.active = false; this.raf = null; this.parts = [];
        this._reset();
    }
    _reset() { this.parts = Array.from({ length: N_PART }, () => this._newP(true)); }
    _newP(rnd) {
        return { lat: PAR.latMin + Math.random()*(PAR.latMax-PAR.latMin),
                 lon: PAR.lonMin + Math.random()*(PAR.lonMax-PAR.lonMin),
                 age: rnd ? Math.floor(Math.random()*MAX_AGE) : 0 };
    }
    setGrid(g) { this.grid = g; this.clearTrails(); }
    clearTrails() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
    _bilerp(lat, lon, f) {
        const ty=(lat-PAR.latMin)/(PAR.latMax-PAR.latMin)*(GRID_N-1);
        const tx=(lon-PAR.lonMin)/(PAR.lonMax-PAR.lonMin)*(GRID_N-1);
        const i=Math.floor(ty), j=Math.floor(tx);
        if(i<0||i>=GRID_N-1||j<0||j>=GRID_N-1) return 0;
        const fy=ty-i, fx=tx-j;
        return (1-fy)*((1-fx)*f[i][j]+fx*f[i][j+1])+fy*((1-fx)*f[i+1][j]+fx*f[i+1][j+1]);
    }
    _color(spd) {
        const t=Math.min(Math.max(spd/45,0),1);
        const st=[[0,[3,80,200]],[.15,[0,200,255]],[.35,[0,230,70]],[.55,[255,230,0]],[.75,[255,120,0]],[1,[255,30,30]]];
        for(let s=0;s<st.length-1;s++){
            const[t0,c0]=st[s],[t1,c1]=st[s+1];
            if(t>=t0&&t<=t1){const f=(t-t0)/(t1-t0);return c0.map((v,i)=>Math.round(v+f*(c1[i]-v)));}
        }
        return[255,30,30];
    }
    _frame() {
        if(!this.active) return;
        const ctx=this.ctx, W=this.canvas.width, H=this.canvas.height;
        ctx.globalCompositeOperation='destination-out';
        ctx.fillStyle=`rgba(0,0,0,${FADE})`;
        ctx.fillRect(0,0,W,H);
        ctx.globalCompositeOperation='source-over';
        if(!this.grid){this.raf=requestAnimationFrame(()=>this._frame());return;}
        const cosLat=Math.cos(((PAR.latMin+PAR.latMax)/2)*Math.PI/180);
        for(const p of this.parts){
            p.age++;
            if(p.age>MAX_AGE){Object.assign(p,this._newP(false));continue;}
            const u=this._bilerp(p.lat,p.lon,this.grid.u);
            const v=this._bilerp(p.lat,p.lon,this.grid.v);
            const spd=Math.hypot(u,v);
            const pt0=this.map.latLngToContainerPoint([p.lat,p.lon]);
            if(spd>0.05){const sc=SPD_SCALE*(0.3+0.7*Math.min(spd/20,1));p.lon+=(u/spd)*sc/cosLat;p.lat+=(v/spd)*sc;}
            if(p.lat<PAR.latMin||p.lat>PAR.latMax||p.lon<PAR.lonMin||p.lon>PAR.lonMax){Object.assign(p,this._newP(false));continue;}
            const pt1=this.map.latLngToContainerPoint([p.lat,p.lon]);
            const dx=pt1.x-pt0.x, dy=pt1.y-pt0.y;
            if(dx*dx+dy*dy<0.04) continue;
            const alpha=Math.max(0.05,0.9*(1-p.age/MAX_AGE));
            const[r,g,b]=this._color(spd);
            ctx.beginPath();ctx.moveTo(pt0.x,pt0.y);ctx.lineTo(pt1.x,pt1.y);
            ctx.strokeStyle=`rgba(${r},${g},${b},${alpha})`;ctx.lineWidth=1.3;ctx.stroke();
        }
        this.raf=requestAnimationFrame(()=>this._frame());
    }
    start(){if(this.active)return;this.active=true;this.raf=requestAnimationFrame(()=>this._frame());}
    stop(){this.active=false;if(this.raf){cancelAnimationFrame(this.raf);this.raf=null;}this.clearTrails();}
}

// ── Client-side Rankine Vortex ─────────────────────────────
function rankineGrid(stormLat, stormLon, windKt, pressure) {
    const Vmax=windKt*0.514444;
    const dp=Math.max(0,1013-pressure);
    const Rmax=Math.max(15,46.4*Math.exp(-0.0155*dp+0.0169*stormLat));
    const cosLat=Math.cos(stormLat*Math.PI/180);
    const KM=111.0;
    const u=Array.from({length:GRID_N},()=>new Array(GRID_N).fill(0));
    const v=Array.from({length:GRID_N},()=>new Array(GRID_N).fill(0));
    for(let i=0;i<GRID_N;i++){
        const lat=PAR.latMin+(i/(GRID_N-1))*(PAR.latMax-PAR.latMin);
        for(let j=0;j<GRID_N;j++){
            const lon=PAR.lonMin+(j/(GRID_N-1))*(PAR.lonMax-PAR.lonMin);
            const dy=(lat-stormLat)*KM, dx=(lon-stormLon)*KM*cosLat;
            const dist=Math.max(0.5,Math.hypot(dy,dx));
            const V=dist<=Rmax?Vmax*(dist/Rmax):Vmax*Math.sqrt(Rmax/dist);
            u[i][j]=-V*(dy/dist)-3.0; v[i][j]=V*(dx/dist)+0.8;
        }
    }
    return{u,v};
}

// ── Real Grid Wind (from Open-Meteo forecast) ──────────────
async function loadWindFromGrid() {
    try {
        const data = await fetch(`/api/weather/grid?region=par&forecast_hour=${S.forecastHour}`).then(r=>r.json());
        if (data.status !== 'success') throw new Error('grid fail');
        const u = Array.from({length:GRID_N}, ()=>new Array(GRID_N).fill(0));
        const v = Array.from({length:GRID_N}, ()=>new Array(GRID_N).fill(0));
        // Map 12×8 Open-Meteo points → 20×20 wind grid (nearest-neighbour + fill)
        const mapped = [];
        data.points.forEach(pt => {
            if (pt.wind_speed === null || pt.wind_dir === null) return;
            const wsMps = (pt.wind_speed || 0) / 3.6;  // km/h → m/s
            const wRad  = (pt.wind_dir || 0) * Math.PI / 180;
            const uv    = { u: -wsMps * Math.sin(wRad), v: -wsMps * Math.cos(wRad) };
            const i = Math.round((pt.lat - PAR.latMin) / (PAR.latMax - PAR.latMin) * (GRID_N-1));
            const j = Math.round((pt.lon - PAR.lonMin) / (PAR.lonMax - PAR.lonMin) * (GRID_N-1));
            if (i>=0&&i<GRID_N&&j>=0&&j<GRID_N) { u[i][j]=uv.u; v[i][j]=uv.v; mapped.push({i,j,lat:pt.lat,lon:pt.lon,...uv}); }
        });
        // Fill gaps
        for (let i=0;i<GRID_N;i++) for (let j=0;j<GRID_N;j++) {
            if (u[i][j]!==0||v[i][j]!==0) continue;
            const lat=PAR.latMin+i/(GRID_N-1)*(PAR.latMax-PAR.latMin);
            const lon=PAR.lonMin+j/(GRID_N-1)*(PAR.lonMax-PAR.lonMin);
            let best=null,bd=Infinity;
            mapped.forEach(m=>{const d=Math.hypot(m.lat-lat,m.lon-lon);if(d<bd){bd=d;best=m;}});
            if(best){u[i][j]=best.u;v[i][j]=best.v;}
        }
        S.windEngine.setGrid({u,v});
        if(!S.windEngine.active) S.windEngine.start();
        const hr = S.forecastHour;
        const label = hr===0 ? 'Now' : `+${hr}h`;
        showToast(`Wind — ${label} · real forecast from Open-Meteo`);
    } catch(e) {
        S.windEngine.start();
    }
}

// ── Ensemble Kinematic Forecast ────────────────────────────
function computeVelocity(path, n=6) {
    const pts = path.slice(-Math.max(2, Math.min(n, path.length)));
    if (pts.length < 2) return { vLat: 0.04, vLon: -0.07 };
    let sL=0, sO=0;
    for (let i=1; i<pts.length; i++) {
        sL += pts[i].lat - pts[i-1].lat;
        sO += (pts[i].lon||pts[i].lon) - (pts[i-1].lon||pts[i-1].lon);
    }
    return { vLat: sL/(pts.length-1), vLon: sO/(pts.length-1) };
}

function kineticMember(storm, vel, pertVLat, pertVLon, betaMult, steps=56) {
    const track = [];
    let lat=storm.lat, lon=storm.lon;
    let pres=storm.pressure||990, wind=storm.wind_speed||45;
    const BLAT=0.020*betaMult, BLON=-0.008*betaMult;
    for (let i=0; i<steps; i++) {
        let rec=0;
        if (lat>18) rec=0.005*(lat-18)/10;
        lat=Math.max(0, Math.min(65, lat+vel.vLat+BLAT+pertVLat));
        lon=Math.max(90, Math.min(185, lon+vel.vLon+BLON+pertVLon+rec));
        pres=Math.min(1013, pres+1.1); wind=Math.max(15, wind-0.65);
        track.push({ lat, lon, hour:(i+1)*3, pressure:pres, wind_speed:wind });
    }
    return track;
}

function runEnsemble(storm, path, N=ENSEMBLE_N) {
    const vel = computeVelocity(path && path.length>1 ? path : [storm,storm]);
    return Array.from({ length: N }, () => {
        const pertVLat=(Math.random()-0.5)*0.10;
        const pertVLon=(Math.random()-0.5)*0.10;
        const betaMult=0.65+Math.random()*0.7;
        return kineticMember(storm, vel, pertVLat, pertVLon, betaMult, 56);
    });
}

function drawEnsemble(members, stormCat) {
    S.ensembleGroup.clearLayers();
    const mainColor = CAT_COLOR[Math.min(stormCat,5)];
    members.forEach(track => {
        L.polyline(track.map(p=>[p.lat,p.lon]), {
            color:mainColor, weight:1.5, opacity:0.18, dashArray:'3,7', interactive:false,
        }).addTo(S.ensembleGroup);
    });
    const steps=members[0].length;
    const leftBound=[], rightBound=[];
    for (let i=0;i<steps;i+=4) {
        const lats=members.map(m=>m[i].lat).sort((a,b)=>a-b);
        const lons=members.map(m=>m[i].lon).sort((a,b)=>a-b);
        const lo=Math.max(0,Math.floor(members.length*0.05));
        const hi=Math.min(members.length-1,Math.ceil(members.length*0.95));
        const mLat=(lats[lo]+lats[hi])/2, mLon=(lons[lo]+lons[hi])/2;
        const dLat=(lats[hi]-lats[lo])/2, dLon=(lons[hi]-lons[lo])/2;
        leftBound.push([mLat+dLat,mLon-dLon]);
        rightBound.push([mLat-dLat,mLon+dLon]);
    }
    const conePts=[...leftBound,...rightBound.reverse()];
    if(conePts.length>3) L.polygon(conePts,{
        color:mainColor, weight:1, opacity:0.25,
        fillColor:mainColor, fillOpacity:0.07, interactive:false,
    }).addTo(S.ensembleGroup);
}

// ── Rain Radar (RainViewer) ────────────────────────────────
async function loadRainViewer() {
    try {
        const data = await fetch('https://api.rainviewer.com/public/weather-maps.json').then(r=>r.json());
        const frames = [...(data.radar.past||[]), ...(data.radar.nowcast||[])];
        if (!frames.length) { showToast('Rain radar: no frames available'); return; }
        S.rainFrames = frames;
        _showRainFrame(frames.length-1);
        showToast(`Rain radar — ${frames.length} frames · live data`);
    } catch(e) { showToast('Rain radar unavailable (check connection)'); }
}

function _showRainFrame(idx) {
    if (S.rainLayer) { _map.removeLayer(S.rainLayer); S.rainLayer=null; }
    const frame = S.rainFrames[idx]; if (!frame) return;
    S.rainLayer = L.tileLayer(
        `https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
        { opacity:0.70, attribution:'© RainViewer', zIndex:150 }
    ).addTo(_map);
}

function removeRainLayer() {
    if (S.rainLayer) { _map.removeLayer(S.rainLayer); S.rainLayer=null; }
    S.rainFrames = [];
}

// ── Shared Overlay Canvas ──────────────────────────────────
function _showOverlayCanvas() {
    const canvas = document.getElementById('temp-canvas');
    const cont   = _map.getContainer();
    if (canvas.parentNode !== cont) cont.appendChild(canvas);
    Object.assign(canvas.style, {
        display:'block', position:'absolute', top:'0', left:'0',
        width:'100%', height:'100%', pointerEvents:'none', zIndex:'200',
    });
}

function removeOverlayCanvas() {
    S.tempCanvasActive = false;
    S.overlayType = null;
    S.tempPoints = null; S.cloudPoints = null; S.wavePoints = null;
    const canvas = document.getElementById('temp-canvas');
    canvas.style.display = 'none';
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// Alias
function removeTempLayer() { removeOverlayCanvas(); }

function _resizeCanvas() {
    const canvas = document.getElementById('temp-canvas');
    const cont   = _map.getContainer();
    canvas.width  = cont.clientWidth;
    canvas.height = cont.clientHeight;
    return canvas;
}

function _redrawOverlay() {
    if (!S.tempCanvasActive) return;
    if      (S.overlayType==='temp'  && S.tempPoints)  _drawTempCanvas(S.tempPoints);
    else if (S.overlayType==='heat'  && S.tempPoints)  _drawHeatCanvas(S.tempPoints);
    else if (S.overlayType==='cloud' && S.cloudPoints) _drawCloudCanvas(S.cloudPoints);
    else if (S.overlayType==='wave'  && S.wavePoints)  _drawWaveCanvas(S.wavePoints);
}

// ── Core Smooth Overlay Renderer ───────────────────────────
// Paints solid circles on an offscreen canvas, then composites
// with Gaussian blur to produce continuous Windy-style color fields.
function _drawSmoothOverlay(canvas, pts, colorFn, valFn, overlayAlpha, blurPx) {
    if (!pts || !pts.length) return;
    const W=canvas.width, H=canvas.height;
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,W,H);

    // Radius = 85% of projected inter-point distance (fills gaps smoothly)
    let radius = 90;
    try {
        const p0=_map.latLngToContainerPoint([pts[0].lat,pts[0].lon]);
        const p1=_map.latLngToContainerPoint([pts[1].lat,pts[1].lon]);
        radius = Math.max(55, Math.hypot(p1.x-p0.x, p1.y-p0.y)*0.85);
    } catch(_){}

    const tmp = document.createElement('canvas');
    tmp.width=W; tmp.height=H;
    const tctx=tmp.getContext('2d');

    pts.forEach(pt => {
        const val = valFn(pt);
        if (val===null||val===undefined) return;
        const ll=_map.latLngToContainerPoint([pt.lat,pt.lon]);
        const[r,g,b]=colorFn(val);
        tctx.fillStyle=`rgb(${r},${g},${b})`;
        tctx.beginPath(); tctx.arc(ll.x,ll.y,radius,0,Math.PI*2); tctx.fill();
    });

    ctx.save();
    ctx.globalAlpha=overlayAlpha;
    ctx.filter=blurPx>0?`blur(${blurPx}px)`:'none';
    ctx.drawImage(tmp,0,0);
    ctx.restore();
}

// ── Temperature Layer ──────────────────────────────────────
async function loadTemperatureLayer() {
    try {
        const data = await fetch(`/api/weather/grid?region=par&forecast_hour=${S.forecastHour}`).then(r=>r.json());
        if (data.status !== 'success') throw new Error('Grid unavailable');
        const pts = data.points.filter(p=>p.temp!==null&&p.temp!==undefined);
        if (!pts.length) { showToast('Temperature data unavailable'); return; }
        S.tempPoints=pts; S.overlayType='temp';
        _showOverlayCanvas(); _drawTempCanvas(pts); S.tempCanvasActive=true;
        const hr=S.forecastHour; const label=hr===0?'Now':`+${hr}h`;
        showToast(`Temperature — ${label} · ${pts.length} points`);
    } catch(e) { showToast('Temperature layer unavailable'); }
}

function _tempColor(t) {
    const stops=[[10,[0,40,200]],[20,[0,160,255]],[26,[0,220,80]],[30,[255,220,0]],[34,[255,80,0]],[38,[200,0,0]]];
    t=Math.max(stops[0][0],Math.min(stops[stops.length-1][0],t));
    for(let s=0;s<stops.length-1;s++){
        const[t0,c0]=stops[s],[t1,c1]=stops[s+1];
        if(t>=t0&&t<=t1){const f=(t-t0)/(t1-t0);return c0.map((v,i)=>Math.round(v+f*(c1[i]-v)));}
    }
    return[200,0,0];
}

function _drawTempCanvas(pts) {
    if (!pts) pts=S.tempPoints; if (!pts) return;
    const canvas=_resizeCanvas();
    _drawSmoothOverlay(canvas, pts, _tempColor, p=>p.temp, 0.70, 16);
}

// ── Heat Index Layer ───────────────────────────────────────
async function loadHeatLayer() {
    try {
        const data = await fetch(`/api/weather/grid?region=par&forecast_hour=${S.forecastHour}`).then(r=>r.json());
        if (data.status !== 'success') throw new Error('Grid unavailable');
        const pts = data.points.filter(p=>(p.heat??p.temp)!==null&&(p.heat??p.temp)!==undefined);
        if (!pts.length) { showToast('Heat data unavailable'); return; }
        S.tempPoints=pts; S.overlayType='heat';
        _showOverlayCanvas(); _drawHeatCanvas(pts); S.tempCanvasActive=true;
        const hr=S.forecastHour; const label=hr===0?'Now':`+${hr}h`;
        showToast(`Heat index — ${label} · ${pts.length} points`);
    } catch(e) { showToast('Heat index layer unavailable'); }
}

function _heatColor(h) {
    const stops=[[18,[0,100,220]],[24,[0,200,80]],[29,[255,230,0]],[33,[255,100,0]],[38,[220,0,0]],[42,[130,0,60]]];
    h=Math.max(stops[0][0],Math.min(stops[stops.length-1][0],h));
    for(let s=0;s<stops.length-1;s++){
        const[h0,c0]=stops[s],[h1,c1]=stops[s+1];
        if(h>=h0&&h<=h1){const f=(h-h0)/(h1-h0);return c0.map((v,i)=>Math.round(v+f*(c1[i]-v)));}
    }
    return[130,0,60];
}

function _drawHeatCanvas(pts) {
    if (!pts) return;
    const canvas=_resizeCanvas();
    _drawSmoothOverlay(canvas, pts, _heatColor, p=>p.heat??p.temp, 0.70, 16);
}

// ── Cloud Cover Layer ──────────────────────────────────────
async function loadCloudLayer() {
    try {
        const data = await fetch(`/api/weather/grid?region=par&forecast_hour=${S.forecastHour}`).then(r=>r.json());
        if (data.status !== 'success') throw new Error('Grid unavailable');
        const pts = data.points.filter(p=>p.cloud!==null&&p.cloud!==undefined);
        if (!pts.length) { showToast('Cloud data unavailable'); return; }
        S.cloudPoints=pts; S.overlayType='cloud';
        _showOverlayCanvas(); _drawCloudCanvas(pts); S.tempCanvasActive=true;
        const hr=S.forecastHour; const label=hr===0?'Now':`+${hr}h`;
        const avgCloud = Math.round(pts.reduce((s,p)=>s+(p.cloud||0),0)/pts.length);
        showToast(`Cloud cover — ${label} · avg ${avgCloud}%`);
    } catch(e) { showToast('Cloud layer unavailable'); }
}

function _drawCloudCanvas(pts) {
    if (!pts) return;
    const canvas=_resizeCanvas();
    const W=canvas.width, H=canvas.height;
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,W,H);

    const active=pts.filter(p=>(p.cloud||0)>10);
    if (!active.length) return;

    let radius=90;
    try {
        const p0=_map.latLngToContainerPoint([active[0].lat,active[0].lon]);
        const p1=_map.latLngToContainerPoint([active[1]?.lat||active[0].lat+2, active[1]?.lon||active[0].lon+2]);
        radius=Math.max(55, Math.hypot(p1.x-p0.x,p1.y-p0.y)*0.85);
    } catch(_){}

    const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
    const tctx=tmp.getContext('2d');
    active.forEach(pt=>{
        const c=pt.cloud||0;
        if (c<10) return;
        const ll=_map.latLngToContainerPoint([pt.lat,pt.lon]);
        const alpha=Math.min(0.95,(c-10)/90);
        tctx.globalAlpha=alpha;
        // White-blue cloud color — brighter for thick cloud
        const g=Math.round(235-c*0.35);
        tctx.fillStyle=`rgb(240,${g},255)`;
        tctx.beginPath(); tctx.arc(ll.x,ll.y,radius,0,Math.PI*2); tctx.fill();
    });
    tctx.globalAlpha=1;

    ctx.save(); ctx.filter='blur(20px)'; ctx.drawImage(tmp,0,0); ctx.restore();
}

// ── Wave Height Layer ──────────────────────────────────────
async function loadWaveLayer() {
    setLoading(true,'Fetching ocean wave data…');
    try {
        const data = await fetch(`/api/weather/marine?forecast_hour=${S.forecastHour}`).then(r=>r.json());
        if (data.status !== 'success') throw new Error('Marine API unavailable');
        const pts=data.points.filter(p=>p.wave_height!==null&&p.wave_height!==undefined);
        if (!pts.length) { showToast('Wave data unavailable (ocean points only)'); return; }
        S.wavePoints=pts; S.overlayType='wave';
        _showOverlayCanvas(); _drawWaveCanvas(pts); S.tempCanvasActive=true;
        const maxWh=Math.max(...pts.map(p=>p.wave_height)).toFixed(1);
        const hr=S.forecastHour; const label=hr===0?'Now':`+${hr}h`;
        showToast(`Waves — ${label} · max ${maxWh} m · ${pts.length} points`);
    } catch(e) { showToast('Wave layer unavailable'); }
    finally { setLoading(false); }
}

function _waveColor(h) {
    const stops=[[0,[160,220,255]],[0.5,[0,170,255]],[1.5,[0,100,230]],[3,[0,40,180]],[5,[60,0,160]],[7,[100,0,80]]];
    h=Math.max(0,Math.min(8,h));
    for(let s=0;s<stops.length-1;s++){
        const[h0,c0]=stops[s],[h1,c1]=stops[s+1];
        if(h>=h0&&h<=h1){const f=(h-h0)/(h1-h0);return c0.map((v,i)=>Math.round(v+f*(c1[i]-v)));}
    }
    return[100,0,80];
}

function _drawWaveCanvas(pts) {
    if (!pts) return;
    const canvas=_resizeCanvas();
    _drawSmoothOverlay(canvas, pts, _waveColor, p=>p.wave_height, 0.72, 18);
}

// ── Seasonal Outlook (Historical Climatology) ──────────────
let _seasonalTrackGroup = null;

async function loadSeasonalOutlook() {
    const now = new Date();
    // Target the month shown at the current slider position
    const targetDate = new Date(now.getTime() + S.forecastHour * 3600000);
    const month = targetDate.getUTCMonth() + 1;
    const year  = targetDate.getUTCFullYear();

    setLoading(true, `Analyzing historical ${_monthName(month)} typhoon patterns…`);
    try {
        const data = await fetch(`/api/climate/outlook?month=${month}&year=${year}`).then(r=>r.json());
        if (data.status !== 'success') throw new Error('Outlook unavailable');

        // Draw track density heatmap on shared overlay canvas
        S.overlayType = 'seasonal';
        S.tempPoints  = data.track_density;
        _showOverlayCanvas();
        _drawSeasonalCanvas(data.track_density);
        S.tempCanvasActive = true;

        // Draw historical analog tracks on map
        if (_seasonalTrackGroup) { _map.removeLayer(_seasonalTrackGroup); }
        _seasonalTrackGroup = L.layerGroup().addTo(_map);
        const CAT_C = ['#87ceeb','#64ee64','#e1e100','#ff8200','#ff0000','#ff00ff'];
        data.historical_tracks.forEach(storm => {
            if (storm.points.length < 2) return;
            const pts = storm.points.map(p => [p.lat, p.lon]);
            const col = CAT_C[Math.min(storm.peak_cat||0,5)];
            L.polyline(pts, { color:col, weight:1.5, opacity:0.30, dashArray:'4,8', interactive:false })
             .addTo(_seasonalTrackGroup);
        });

        const activity = data.activity_level.toUpperCase();
        const analogStr = data.analogs.map(a=>`${a.year}(${a.storms})`).join(', ');
        showToast(`${_monthName(month)} outlook: ${activity} · avg ${data.avg_storms} storms · analogs: ${analogStr}`);

        // Show forecast text in a banner
        _showOutlookBanner(data.forecast_text, data.activity_level);

    } catch(e) { showToast('Seasonal outlook unavailable'); }
    finally { setLoading(false); }
}

function _monthName(m) {
    return ['','January','February','March','April','May','June',
            'July','August','September','October','November','December'][m];
}

function _seasonalColor(d) {
    // 0 = cool blue (no history), 1 = magenta (high frequency corridor)
    const stops = [
        [0,   [20,  30, 80]],
        [0.25,[60,  0,160]],
        [0.5, [150, 0,150]],
        [0.75,[200, 0,100]],
        [1,   [255, 30, 60]],
    ];
    d = Math.max(0, Math.min(1, d));
    for (let s=0; s<stops.length-1; s++) {
        const [d0,c0]=stops[s], [d1,c1]=stops[s+1];
        if (d>=d0&&d<=d1) { const f=(d-d0)/(d1-d0); return c0.map((v,i)=>Math.round(v+f*(c1[i]-v))); }
    }
    return [255,30,60];
}

function _drawSeasonalCanvas(pts) {
    if (!pts) return;
    // Only paint cells with some storm activity
    const active = pts.filter(p => p.density > 0.02);
    if (!active.length) return;
    const canvas = _resizeCanvas();
    _drawSmoothOverlay(canvas, active, _seasonalColor, p=>p.density, 0.62, 18);
}

let _outlookBanner = null;
function _showOutlookBanner(text, level) {
    if (_outlookBanner) { _outlookBanner.remove(); _outlookBanner=null; }
    const colors = {
        'quiet':'#0052cc','below-normal':'#0077aa',
        'normal':'#007744','above-normal':'#cc7700','very active':'#cc2200',
    };
    const bg = colors[level] || '#0052cc';
    const div = document.createElement('div');
    div.id = 'outlook-banner';
    Object.assign(div.style, {
        position:'fixed', top:'62px', left:'50%', transform:'translateX(-50%)',
        background:`${bg}ee`, color:'#fff', borderRadius:'8px',
        padding:'10px 20px', fontSize:'12px', lineHeight:'1.55',
        maxWidth:'520px', textAlign:'center', zIndex:'950',
        boxShadow:'0 4px 18px rgba(0,0,0,.3)', whiteSpace:'pre-line',
        border:`1px solid ${bg}`,
    });
    div.textContent = text;
    const close = document.createElement('button');
    Object.assign(close.style, {
        position:'absolute', top:'4px', right:'8px', background:'none',
        border:'none', color:'#fff', cursor:'pointer', fontSize:'14px', lineHeight:'1',
    });
    close.textContent = '×';
    close.onclick = () => { div.remove(); _outlookBanner=null; };
    div.appendChild(close);
    document.body.appendChild(div);
    _outlookBanner = div;
    setTimeout(() => { if (_outlookBanner===div) { div.remove(); _outlookBanner=null; } }, 12000);
}

function removeSeasonalLayer() {
    if (_seasonalTrackGroup) { _map.removeLayer(_seasonalTrackGroup); _seasonalTrackGroup=null; }
    if (_outlookBanner) { _outlookBanner.remove(); _outlookBanner=null; }
}

// ── Weather Refresh on Timeline Scrub ─────────────────────
let _weatherRefreshTimer=null;
function _scheduleWeatherRefresh() {
    clearTimeout(_weatherRefreshTimer);
    _weatherRefreshTimer=setTimeout(_refreshWeatherLayer, 500);
}

async function _refreshWeatherLayer() {
    if (!S.overlayType) return;
    const hr=S.forecastHour;
    try {
        if (S.overlayType==='temp') {
            const d=await fetch(`/api/weather/grid?region=par&forecast_hour=${hr}`).then(r=>r.json());
            if(d.status==='success'){S.tempPoints=d.points.filter(p=>p.temp!==null);_drawTempCanvas(S.tempPoints);}
        } else if (S.overlayType==='heat') {
            const d=await fetch(`/api/weather/grid?region=par&forecast_hour=${hr}`).then(r=>r.json());
            if(d.status==='success'){S.tempPoints=d.points.filter(p=>(p.heat??p.temp)!==null);_drawHeatCanvas(S.tempPoints);}
        } else if (S.overlayType==='cloud') {
            const d=await fetch(`/api/weather/grid?region=par&forecast_hour=${hr}`).then(r=>r.json());
            if(d.status==='success'){S.cloudPoints=d.points.filter(p=>p.cloud!==null);_drawCloudCanvas(S.cloudPoints);}
        } else if (S.overlayType==='wave') {
            const d=await fetch(`/api/weather/marine?forecast_hour=${hr}`).then(r=>r.json());
            if(d.status==='success'){S.wavePoints=d.points;_drawWaveCanvas(S.wavePoints);}
        }
    } catch(e) { console.warn('Weather refresh:', e); }
}

// ── Storm Marker ───────────────────────────────────────────
function makePulseIcon(color) {
    return L.divIcon({
        className:'',
        html:`<div class="sp"><div class="sr1" style="border-color:${color}50"></div><div class="sr2" style="border-color:${color}90"></div><div class="sd" style="background:${color};box-shadow:0 0 10px 4px ${color}70"></div></div>`,
        iconSize:[44,44], iconAnchor:[22,22],
    });
}

function setStormMarker(lat,lon,cat) {
    const color=CAT_COLOR[Math.min(cat||0,5)];
    if(S.stormMarker){S.stormMarker.setLatLng([lat,lon]).setIcon(makePulseIcon(color));}
    else{S.stormMarker=L.marker([lat,lon],{icon:makePulseIcon(color),zIndexOffset:1000}).addTo(_map);}
}

function removeStormMarker() {
    if(S.stormMarker){_map.removeLayer(S.stormMarker);S.stormMarker=null;}
}

// ── Map Layer Helpers ──────────────────────────────────────
function drawBgTracks(storms) {
    S.bgGroup.clearLayers();
    storms.forEach(s=>{
        if(s.path.length<2)return;
        L.polyline(s.path,{color:CAT_COLOR[Math.min(s.peak_category||0,5)],weight:1.5,opacity:0.22,interactive:false}).addTo(S.bgGroup);
    });
}

function drawActiveTrack(storm) {
    if(S.activeGroup){_map.removeLayer(S.activeGroup);S.activeGroup=null;}
    if(!storm||storm.path.length<2)return;
    S.activeGroup=L.layerGroup().addTo(_map);
    for(let i=0;i<storm.path.length-1;i++){
        const pt=storm.path[i];
        L.polyline([[pt.lat,pt.lon],[storm.path[i+1].lat,storm.path[i+1].lon]],{
            color:CAT_COLOR[Math.min(pt.category||0,5)],weight:3.5,opacity:0.9,
        }).addTo(S.activeGroup);
    }
}

function drawForecastPath(steps) {
    S.fcstGroup.clearLayers();
    if(!steps||steps.length<2)return;
    L.polyline(steps.map(s=>[s.lat,s.lon]),{color:'#0052cc',weight:3,opacity:0.85,dashArray:'8,12'}).addTo(S.fcstGroup);
    steps.forEach((s,i)=>{
        if(i%8!==0&&i!==steps.length-1)return;
        const cat=windToCat(s.wind_speed);
        L.circleMarker([s.lat,s.lon],{radius:6,color:'#fff',weight:1.5,fillColor:CAT_COLOR[Math.min(cat,5)],fillOpacity:0.95})
         .bindTooltip(`+${s.hour}h | ${s.wind_speed.toFixed(0)} kt | ${CAT_LABEL[Math.min(cat,5)]}`,{sticky:true})
         .addTo(S.fcstGroup);
    });
}

function windToCat(wkt) {
    if(wkt<34)return 0;if(wkt<64)return 1;if(wkt<96)return 2;if(wkt<113)return 3;if(wkt<137)return 4;return 5;
}

// ── API Calls ──────────────────────────────────────────────
async function apiLoadYear(year) {
    const[r1,r2]=await Promise.all([fetch(`/api/storms/list?year=${year}`),fetch(`/api/storm/year-tracks?year=${year}`)]);
    if(!r1.ok)throw new Error(`Storm list: HTTP ${r1.status}`);
    if(!r2.ok)throw new Error(`Year tracks: HTTP ${r2.status}`);
    return{stormList:(await r1.json()).storms,yearTracks:(await r2.json()).storms};
}

async function apiLoadStorm(year,name) {
    const r=await fetch(`/api/storm/track?year=${year}&name=${encodeURIComponent(name)}`);
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||`HTTP ${r.status}`);}
    return r.json();
}

async function apiRunForecast(year,name,histHrs) {
    const r=await fetch('/api/forecast/from-storm',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({year,storm_name:name,history_hours:histHrs}),
    });
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||`HTTP ${r.status}`);}
    return r.json();
}

// ── Mode Transitions ───────────────────────────────────────
function enterIdle() {
    S.mode='idle';
    if(S.activeGroup){_map.removeLayer(S.activeGroup);S.activeGroup=null;}
    S.fcstGroup.clearLayers(); S.ensembleGroup.clearLayers();
    removeStormMarker(); removeSeasonalLayer();
    S.activeStorm=null; S.forecast=null;
    stopPlay();
    _initWeatherTimeline();
    showPanelIdle();
}

function enterHistorical(storm) {
    S.mode='historical'; S.activeStorm=storm; S.forecast=null;
    stopPlay();
    drawActiveTrack(storm);
    S.fcstGroup.clearLayers();
    const members=runEnsemble(storm.path[storm.path.length-1],storm.path,ENSEMBLE_N);
    drawEnsemble(members,windToCat(storm.path[storm.path.length-1].wind_speed));
    S.histStep=storm.path.length-1;
    applyHistStep(S.histStep);
    _map.setView([storm.path[S.histStep].lat,storm.path[S.histStep].lon],Math.max(_map.getZoom(),5),{animate:true});
    buildTimeline('historical',storm.path.length);
    showPanelHistorical(storm,storm.path[S.histStep]);
}

function enterForecast(fcst) {
    S.mode='forecast'; S.forecast=fcst;
    const lastPt=S.activeStorm?.path?.[S.activeStorm.path.length-1];
    S.tlBaseTime=lastPt?.time?new Date(lastPt.time.replace(' ','T')+':00Z'):new Date();
    stopPlay();
    drawForecastPath(fcst.forecast_steps);
    const seed=fcst.forecast_steps[0];
    const members=runEnsemble(seed,[{lat:seed.lat,lon:seed.lon}],ENSEMBLE_N);
    drawEnsemble(members,windToCat(seed.wind_speed));
    S.fcstStep=0; applyFcstStep(0);
    buildTimeline('forecast',fcst.forecast_steps.length);
    showPanelForecast(S.activeStorm,fcst.forecast_steps[0],fcst.method);
}

// ── Step Application ───────────────────────────────────────
function applyHistStep(idx) {
    const storm=S.activeStorm; if(!storm)return;
    idx=Math.max(0,Math.min(idx,storm.path.length-1)); S.histStep=idx;
    const pt=storm.path[idx];
    setStormMarker(pt.lat,pt.lon,pt.category);
    if(S.windEngine&&S.showWind) S.windEngine.setGrid(rankineGrid(pt.lat,pt.lon,pt.wind_speed,pt.pressure));
    updateStormStats({lat:pt.lat,lon:pt.lon,pressure:pt.pressure,wind_speed:pt.wind_speed,time:pt.time,cat:pt.category});
    updateTimeLabel(_formatStepTime('historical',idx));
    updateSlider(idx);
    el('tl-step-lbl').textContent=`Step ${idx+1}/${storm.path.length}`;
}

function applyFcstStep(idx) {
    const fcst=S.forecast; if(!fcst)return;
    idx=Math.max(0,Math.min(idx,fcst.forecast_steps.length-1)); S.fcstStep=idx;
    const st=fcst.forecast_steps[idx];
    setStormMarker(st.lat,st.lon,windToCat(st.wind_speed));
    if(S.windEngine&&S.showWind&&st.u&&st.v) S.windEngine.setGrid({u:st.u,v:st.v});
    updateStormStats({lat:st.lat,lon:st.lon,pressure:st.pressure,wind_speed:st.wind_speed,time:`+${st.hour}h`,cat:windToCat(st.wind_speed)});
    updateTimeLabel(_formatStepTime('forecast',idx)); updateSlider(idx);
    el('tl-step-lbl').textContent=`Step ${idx+1}/${fcst.forecast_steps.length}`;
}

// ── Timeline (Windy-style with real dates) ─────────────────
function _stepTime(mode, idx) {
    if (mode==='historical') {
        const pt=S.activeStorm?.path[idx];
        if(!pt?.time) return null;
        return new Date(pt.time.replace(' ','T')+':00Z');
    }
    const base=S.tlBaseTime||new Date();
    return new Date(base.getTime()+idx*3*3600000);
}

function _formatStepTime(mode, idx) {
    const t=_stepTime(mode,idx);
    if(!t) return `Step ${idx+1}`;
    return t.toLocaleDateString('en-US',{
        weekday:'short',month:'short',day:'numeric',year:'numeric',
        hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC',
    }).replace(',',' ') + ' UTC';
}

function _initWeatherTimeline() {
    S.tlBaseTime=new Date();
    el('tl-slider').min=0; el('tl-slider').max=55; el('tl-slider').value=0;
    el('tl-mode-lbl').textContent='7-Day Weather';
    el('tl-storm-lbl').textContent='PAR Region';
    el('tl-step-lbl').textContent='+0h · Now';
    updateTimeLabel(_formatStepTime('forecast',0));
    _buildDateAxis('forecast',56);
    _buildTimeTicks('forecast',56);
}

function buildTimeline(mode, totalSteps) {
    const slider=el('tl-slider');
    slider.min=0; slider.max=totalSteps-1;
    slider.value=mode==='historical'?totalSteps-1:0;
    el('tl-mode-lbl').textContent=mode==='historical'?'Historical Track':'7-Day Forecast';
    el('tl-storm-lbl').textContent=S.activeStorm?.name||'--';
    el('tl-step-lbl').textContent=`Step 1/${totalSteps}`;
    _buildDateAxis(mode,totalSteps);
    _buildTimeTicks(mode,totalSteps);
}

function _buildDateAxis(mode,totalSteps) {
    const row=el('tl-date-labels'); row.innerHTML='';
    const nowDate=new Date().toISOString().slice(0,10);
    const tmrwDate=new Date(Date.now()+86400000).toISOString().slice(0,10);
    let lastDate=null;
    for(let i=0;i<totalSteps;i++){
        const t=_stepTime(mode,i); if(!t) continue;
        const d=t.toISOString().slice(0,10);
        if(d===lastDate) continue; lastDate=d;
        const frac=totalSteps>1?i/(totalSteps-1):0;
        const span=document.createElement('span');
        span.className='tl-date-lbl'; span.style.left=`${frac*100}%`;
        if(d===nowDate){span.textContent='Today';span.classList.add('is-today');}
        else if(d===tmrwDate){span.textContent='Tomorrow';span.classList.add('is-tomorrow');}
        else{span.textContent=t.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});}
        row.appendChild(span);
    }
}

function _buildTimeTicks(mode,totalSteps) {
    const row=el('tl-ticks'); row.innerHTML='';
    for(let i=0;i<totalSteps;i++){
        const t=_stepTime(mode,i); if(!t) continue;
        const hr=t.getUTCHours(); if(hr%12!==0) continue;
        const frac=totalSteps>1?i/(totalSteps-1):0;
        const span=document.createElement('span');
        span.className='tl-tick'; span.style.left=`${frac*100}%`;
        span.textContent=hr===0?'00:00':`${hr}:00`;
        row.appendChild(span);
    }
}

function showTimeline() { el('timeline-bar').classList.remove('hidden'); }
function hideTimeline()  { el('timeline-bar').classList.add('hidden'); }
function updateSlider(v) { el('tl-slider').value=v; }
function updateTimeLabel(s) { el('tl-time-lbl').textContent=s; }

// ── Playback ───────────────────────────────────────────────
function togglePlay() {
    if(S.isPlaying){stopPlay();return;}
    // Weather mode playback (step through 7-day forecast)
    if(S.mode==='idle'){
        S.isPlaying=true; el('btn-play').innerHTML='&#9646;&#9646;';
        const slider=el('tl-slider');
        if(parseInt(slider.value)>=55) slider.value=0;
        S.playTimer=setInterval(()=>{
            const cur=parseInt(slider.value);
            if(cur>=55){stopPlay();return;}
            const next=cur+1; slider.value=next;
            _applyWeatherStep(next);
        },PLAY_MS);
        return;
    }
    if(S.mode!=='historical'&&S.mode!=='forecast')return;
    S.isPlaying=true; el('btn-play').innerHTML='&#9646;&#9646;';
    const total=S.mode==='historical'?S.activeStorm.path.length:S.forecast.forecast_steps.length;
    const slider=el('tl-slider');
    if(parseInt(slider.value)>=total-1) slider.value=0;
    S.playTimer=setInterval(()=>{
        const cur=parseInt(slider.value);
        if(cur>=total-1){stopPlay();return;}
        const next=cur+1; slider.value=next;
        if(S.mode==='historical') applyHistStep(next);
        else applyFcstStep(next);
    },PLAY_MS);
}

function stopPlay() {
    S.isPlaying=false; clearInterval(S.playTimer); S.playTimer=null;
    el('btn-play').innerHTML='&#9654;';
}

function _applyWeatherStep(idx) {
    S.forecastHour=idx*3;
    updateTimeLabel(_formatStepTime('forecast',idx));
    const hr=S.forecastHour;
    el('tl-step-lbl').textContent=hr===0?'+0h · Now':`+${hr}h`;
    if(S.tempCanvasActive) _scheduleWeatherRefresh();
    if(S.showWind&&S.windEngine) _scheduleWindRefresh();
}

let _windRefreshTimer=null;
function _scheduleWindRefresh() {
    clearTimeout(_windRefreshTimer);
    _windRefreshTimer=setTimeout(loadWindFromGrid, 800);
}

// ── UI Panel State ─────────────────────────────────────────
function showPanelIdle() {
    el('storm-info-section').classList.add('hidden');
    el('action-section').classList.add('hidden');
    el('hist-hrs-group').style.display='none';
}

function showPanelHistorical(storm,pt) {
    el('storm-info-section').classList.remove('hidden');
    el('action-section').classList.remove('hidden');
    el('hist-actions').classList.remove('hidden');
    el('fcst-actions').classList.add('hidden');
    el('hist-hrs-group').style.display='block';
    el('active-source-info').classList.add('hidden');
    el('info-mode-badge').textContent='Historical';
    el('info-mode-badge').className='mode-badge badge-hist';
    el('info-name').textContent=storm.name;
    updateStormStats({lat:pt.lat,lon:pt.lon,pressure:pt.pressure,wind_speed:pt.wind_speed,time:pt.time,cat:pt.category});
}

function showPanelForecast(storm,step0,method) {
    el('storm-info-section').classList.remove('hidden');
    el('action-section').classList.remove('hidden');
    el('hist-actions').classList.add('hidden');
    el('fcst-actions').classList.remove('hidden');
    el('info-mode-badge').textContent='AI Forecast';
    el('info-mode-badge').className='mode-badge badge-fcst';
    el('info-name').textContent=storm.name;
    el('fcst-method-badge').textContent=(method||'physics').toUpperCase();
    updateStormStats({lat:step0.lat,lon:step0.lon,pressure:step0.pressure,wind_speed:step0.wind_speed,time:`+${step0.hour}h`,cat:windToCat(step0.wind_speed)});
}

function updateStormStats({lat,lon,pressure,wind_speed,time,cat}) {
    const c=Math.min(cat??windToCat(wind_speed),5);
    el('info-cat').textContent=CAT_LABEL[c]; el('info-cat').style.color=CAT_COLOR[c];
    el('info-pos').textContent=`${lat.toFixed(2)}°N, ${lon.toFixed(2)}°E`;
    el('info-pres').textContent=`${pressure.toFixed(0)} hPa`;
    el('info-wind').textContent=`${wind_speed.toFixed(0)} kt  (${(wind_speed*0.514).toFixed(1)} m/s)`;
    el('info-lead').textContent=time||'--';
    el('topbar-status').textContent=`${S.activeStorm?.name||'PAR Weather'} · ${CAT_NAME[c]}`;
}

// ── Main UI Actions ────────────────────────────────────────
async function onLoadYear() {
    const year=parseInt(el('inp-year').value);
    if(!year||year<2013||year>2025){showErr('Year must be 2013–2025');return;}
    S.year=year; setLoading(true);
    try{
        const{stormList,yearTracks}=await apiLoadYear(year);
        S.stormList=stormList; drawBgTracks(yearTracks);
        const sel=el('inp-storm');
        sel.innerHTML='<option value="">— Select a storm —</option>';
        stormList.forEach(s=>{
            const opt=document.createElement('option');
            opt.value=s.name; opt.textContent=`${s.name}  (${s.points} pts)`; sel.appendChild(opt);
        });
        sel.disabled=false; hideErr();
        showToast(`${stormList.length} storms loaded for ${year}`);
    }catch(e){showErr(e.message);}
    finally{setLoading(false);}
}

async function onSelectStorm(name) {
    if(!name){enterIdle();return;}
    setLoading(true);
    try{const storm=await apiLoadStorm(S.year,name);enterHistorical(storm);hideErr();}
    catch(e){showErr(e.message);}
    finally{setLoading(false);}
}

async function onRunForecast() {
    if(!S.activeStorm)return;
    const histHrs=parseInt(el('inp-hist-hrs').value)||48;
    setLoading(true,`Running 7-day AI forecast for ${S.activeStorm.name}…`);
    try{
        const fcst=await apiRunForecast(S.year,S.activeStorm.name,histHrs);
        enterForecast(fcst); hideErr();
        showToast(`Forecast: ${fcst.method.toUpperCase()} engine — 56 steps, ${ENSEMBLE_N} ensemble members`);
    }catch(e){showErr(e.message);}
    finally{setLoading(false);}
}

function onBackToHistorical() {
    if(S.activeStorm) enterHistorical(S.activeStorm); else enterIdle();
}

// ── Layer Management ───────────────────────────────────────
async function handleLayerPill(layer, btn) {
    document.querySelectorAll('.layer-pill').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    removeOverlayCanvas();
    removeRainLayer();
    removeSeasonalLayer();

    if (layer==='wind') {
        S.showWind=true;
        // In weather mode: use real grid wind; in storm mode: Rankine vortex already running
        if(S.mode==='idle') { await loadWindFromGrid(); }
        else if(S.windEngine&&!S.windEngine.active) S.windEngine.start();
    } else if (layer==='rain') {
        S.showWind=false; if(S.windEngine) S.windEngine.stop();
        await loadRainViewer();
    } else if (layer==='temp') {
        S.showWind=false; if(S.windEngine) S.windEngine.stop();
        await loadTemperatureLayer();
    } else if (layer==='heat') {
        S.showWind=false; if(S.windEngine) S.windEngine.stop();
        await loadHeatLayer();
    } else if (layer==='cloud') {
        S.showWind=false; if(S.windEngine) S.windEngine.stop();
        await loadCloudLayer();
    } else if (layer==='wave') {
        S.showWind=false; if(S.windEngine) S.windEngine.stop();
        await loadWaveLayer();
    } else if (layer==='seasonal') {
        S.showWind=false; if(S.windEngine) S.windEngine.stop();
        await loadSeasonalOutlook();
    } else if (layer==='satellite') {
        S.showWind=false; if(S.windEngine) S.windEngine.stop();
        _switchBaseTile('satellite');
        showToast('Satellite view — Esri World Imagery');
    }
}

// ── Helpers ────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function setLoading(on,msg) {
    const ov=el('loading-indicator');
    if(on){if(msg) el('loading-msg').textContent=msg;ov.classList.remove('hidden');el('err-panel').classList.add('hidden');}
    else{ov.classList.add('hidden');}
}
function showErr(msg){el('err-panel').textContent=msg;el('err-panel').classList.remove('hidden');el('loading-indicator').classList.add('hidden');}
function hideErr(){el('err-panel').classList.add('hidden');}

function showToast(msg) {
    const t=el('toast'); t.textContent=msg; t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'),3500);
}

function tickClock() {
    const e=el('topbar-time');
    if(e) e.textContent=new Date().toUTCString().replace('GMT','UTC').slice(0,25);
}

// ── Event Wiring ───────────────────────────────────────────
function wireEvents() {
    el('btn-load-year').addEventListener('click', onLoadYear);
    el('inp-year').addEventListener('keydown', e=>{if(e.key==='Enter')onLoadYear();});
    el('inp-storm').addEventListener('change', e=>{
        const v=e.target.value; if(v) onSelectStorm(v); else enterIdle();
    });
    el('btn-run-forecast').addEventListener('click', onRunForecast);
    el('btn-back-hist').addEventListener('click', onBackToHistorical);
    el('btn-play').addEventListener('click', togglePlay);

    el('btn-step-back').addEventListener('click', ()=>{
        if(S.isPlaying) stopPlay();
        const idx=Math.max(0,parseInt(el('tl-slider').value)-1);
        el('tl-slider').value=idx;
        if(S.mode==='historical') applyHistStep(idx);
        else if(S.mode==='forecast') applyFcstStep(idx);
        else _applyWeatherStep(idx);
    });
    el('btn-step-fwd').addEventListener('click', ()=>{
        if(S.isPlaying) stopPlay();
        const max=parseInt(el('tl-slider').max);
        const idx=Math.min(max, parseInt(el('tl-slider').value)+1);
        el('tl-slider').value=idx;
        if(S.mode==='historical') applyHistStep(idx);
        else if(S.mode==='forecast') applyFcstStep(idx);
        else _applyWeatherStep(idx);
    });

    el('tl-slider').addEventListener('input', e=>{
        const idx=parseInt(e.target.value);
        if(S.isPlaying) stopPlay();
        if(S.mode==='historical') applyHistStep(idx);
        else if(S.mode==='forecast') applyFcstStep(idx);
        else _applyWeatherStep(idx);
    });

    document.querySelectorAll('.layer-pill').forEach(btn=>{
        btn.addEventListener('click', ()=>handleLayerPill(btn.dataset.layer,btn));
    });
    document.querySelectorAll('.map-type-btn').forEach(btn=>{
        btn.addEventListener('click', ()=>_switchBaseTile(btn.dataset.map));
    });
}

// ── Bootstrap ──────────────────────────────────────────────
async function init() {
    initMap();
    initWindCanvas();
    wireEvents();
    tickClock(); setInterval(tickClock, 15000);

    // Always-on 7-day weather timeline
    _initWeatherTimeline();
    showTimeline();
    S.windEngine.start();

    // Auto-load 2024 background tracks
    try {
        const{stormList,yearTracks}=await apiLoadYear(2024);
        drawBgTracks(yearTracks);
        S.stormList=stormList;
        const sel=el('inp-storm');
        sel.innerHTML='<option value="">— Select a storm —</option>';
        stormList.forEach(s=>{
            const opt=document.createElement('option');
            opt.value=s.name; opt.textContent=`${s.name}  (${s.points} pts)`; sel.appendChild(opt);
        });
        sel.disabled=false;
        el('topbar-status').textContent='PAR Weather · 7-Day Forecast — Select a layer or historical storm';
        showToast(`${stormList.length} historical storms loaded · Scrub timeline for forecast dates`);
    } catch(e){ console.warn('Auto-load 2024:', e.message); }
}

document.addEventListener('DOMContentLoaded', ()=>{
    try { init(); }
    catch(e) {
        document.body.insertAdjacentHTML('beforeend',
            `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#cc2200;background:#fff;padding:24px 32px;border-radius:10px;border:2px solid #cc2200;z-index:9999;font-size:13px;">Init error: ${e.message}</div>`);
    }
});
