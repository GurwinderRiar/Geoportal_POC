"""
GeoPortal Backend — Flask API Server  (Python 3.8+ compatible)
"""
import os, json, glob, time, threading
from pathlib import Path
from typing import Optional

from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS

HAS_GPD = False
gpd = None
pd = None

def _load_gpd():
    global gpd, pd, HAS_GPD
    if not HAS_GPD:
        try:
            import geopandas as _gpd
            import pandas as _pd
            gpd = _gpd
            pd = _pd
            HAS_GPD = True
        except ImportError:
            pass
    return HAS_GPD

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False

BASE_DIR     = Path(__file__).parent
DATA_DIR     = BASE_DIR / "data"
FRONTEND_DIR = BASE_DIR.parent / "frontend"
DATA_DIR.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
CORS(app)

layer_cache = {}
cache_lock  = threading.Lock()

NAME_TYPE = {
    "admin":"polygon","boundary":"polygon","boundaries":"polygon",
    "building":"polygon","buildings":"polygon","landuse":"polygon",
    "land_use":"polygon","parcel":"polygon","zone":"polygon","block":"polygon",
    "water":"polyline","water_supply":"polyline","sewerage":"polyline","sewer":"polyline",
    "road":"polyline","roads":"polyline","street":"polyline","streets":"polyline",
    "pipe":"polyline","pipeline":"polyline","network":"polyline","drain":"polyline",
    "chamber":"point","chambers":"point","manhole":"point","manholes":"point",
    "utility":"point","utilities":"point","hydrant":"point","valve":"point",
    "pump":"point","asset":"point","assets":"point","well":"point","tower":"point",
}
GEOM_MAP = {
    "Point":"point","MultiPoint":"point",
    "LineString":"polyline","MultiLineString":"polyline",
    "Polygon":"polygon","MultiPolygon":"polygon",
}
COLORS = ["#4FC3F7","#81C784","#FFB74D","#E57373","#CE93D8",
          "#4DB6AC","#F06292","#AED581","#FFD54F","#26C6DA",
          "#7986CB","#A1887F","#90A4AE","#FF8A65","#4DD0E1"]

DEF_STYLE = {
    "polygon": {"fillOpacity":0.2,"weight":2,"opacity":0.9},
    "polyline": {"weight":3,"opacity":0.9},
    "point":   {"radius":7,"fillOpacity":0.9,"weight":2,"opacity":1},
}

def detect_type(name, gdf=None):
    n = name.lower()
    for k,v in NAME_TYPE.items():
        if k in n: return v
    if gdf is not None and len(gdf):
        return GEOM_MAP.get(gdf.geometry.geom_type.iloc[0], "polygon")
    return "polygon"

def make_style(ltype, color):
    s = dict(DEF_STYLE[ltype])
    s["color"] = color
    if ltype in ("polygon","point"):
        s["fillColor"] = color
    return s

def load_shp(path):
    if not _load_gpd(): return None
    try:
        gdf = gpd.read_file(path)
        if gdf.crs is None: gdf = gdf.set_crs("EPSG:4326")
        elif gdf.crs.to_epsg() != 4326: gdf = gdf.to_crs("EPSG:4326")
        for col in gdf.columns:
            if pd.api.types.is_datetime64_any_dtype(gdf[col]):
                gdf[col] = gdf[col].astype(str)
        name = Path(path).stem
        return dict(name=name, type=detect_type(name, gdf),
                    geojson=json.loads(gdf.to_json()),
                    bounds=gdf.total_bounds.tolist(), count=len(gdf),
                    fields=[c for c in gdf.columns if c != "geometry"],
                    file_path=path, loaded_at=time.time())
    except Exception as e:
        print("[ERR] %s: %s" % (path, e)); return None

def refresh_all():
    shps = (glob.glob(str(DATA_DIR / "**/*.shp"), recursive=True) +
            glob.glob(str(DATA_DIR / "*.shp")))
    with cache_lock:
        layer_cache.clear()
        for i, shp in enumerate(shps):
            d = load_shp(shp)
            if d:
                d["style"] = make_style(d["type"], COLORS[i % len(COLORS)])
                layer_cache[d["name"]] = d
                print("[LOAD] %s | %s | %d" % (d["name"], d["type"], d["count"]))
    if not layer_cache:
        _load_samples()

def _load_samples():
    raw = [
        {"name":"administrative_boundaries","type":"polygon","color":"#4FC3F7",
         "bounds":[72.82,18.97,72.93,19.08],"fields":["name","population","area_km2"],
         "features":[
            {"props":{"name":"District A","population":45000,"area_km2":12.5},"coords":[[[72.82,18.97],[72.87,18.97],[72.87,19.02],[72.82,19.02],[72.82,18.97]]]},
            {"props":{"name":"District B","population":33000,"area_km2":9.3},"coords":[[[72.87,18.97],[72.93,18.97],[72.93,19.02],[72.87,19.02],[72.87,18.97]]]},
            {"props":{"name":"District C","population":62000,"area_km2":15.1},"coords":[[[72.82,19.02],[72.93,19.02],[72.93,19.08],[72.82,19.08],[72.82,19.02]]]},
        ]},
        {"name":"buildings","type":"polygon","color":"#FFB74D",
         "bounds":[72.832,18.975,72.890,19.011],"fields":["id","use","floors","year"],
         "features":[
            {"props":{"id":"B001","use":"Residential","floors":4,"year":2010},"coords":[[[72.832,18.975],[72.836,18.975],[72.836,18.979],[72.832,18.979],[72.832,18.975]]]},
            {"props":{"id":"B002","use":"Commercial","floors":8,"year":2015},"coords":[[[72.841,18.982],[72.846,18.982],[72.846,18.987],[72.841,18.987],[72.841,18.982]]]},
            {"props":{"id":"B003","use":"Industrial","floors":2,"year":2005},"coords":[[[72.856,18.990],[72.863,18.990],[72.863,18.996],[72.856,18.996],[72.856,18.990]]]},
            {"props":{"id":"B004","use":"Residential","floors":5,"year":2018},"coords":[[[72.871,18.978],[72.875,18.978],[72.875,18.983],[72.871,18.983],[72.871,18.978]]]},
            {"props":{"id":"B005","use":"Mixed Use","floors":10,"year":2020},"coords":[[[72.884,19.005],[72.890,19.005],[72.890,19.011],[72.884,19.011],[72.884,19.005]]]},
        ]},
        {"name":"land_use","type":"polygon","color":"#81C784",
         "bounds":[72.825,18.972,72.890,19.005],"fields":["category","area_ha","density"],
         "features":[
            {"props":{"category":"Residential","area_ha":45.2,"density":"Medium"},"coords":[[[72.825,18.972],[72.848,18.972],[72.848,18.990],[72.825,18.990],[72.825,18.972]]]},
            {"props":{"category":"Commercial","area_ha":22.8,"density":"High"},"coords":[[[72.848,18.972],[72.868,18.972],[72.868,18.990],[72.848,18.990],[72.848,18.972]]]},
            {"props":{"category":"Green Space","area_ha":31.5,"density":"Low"},"coords":[[[72.868,18.972],[72.890,18.972],[72.890,18.990],[72.868,18.990],[72.868,18.972]]]},
            {"props":{"category":"Industrial","area_ha":18.0,"density":"Low"},"coords":[[[72.825,18.990],[72.890,18.990],[72.890,19.005],[72.825,19.005],[72.825,18.990]]]},
        ]},
        {"name":"road_network","type":"polyline","color":"#90A4AE",
         "bounds":[72.820,18.972,72.900,19.030],"fields":["name","class","lanes"],
         "features":[
            {"props":{"name":"Main Road","class":"Primary","lanes":4},"coords":[[72.820,18.990],[72.840,18.990],[72.860,18.992],[72.880,18.992],[72.900,18.993]]},
            {"props":{"name":"North Avenue","class":"Secondary","lanes":2},"coords":[[72.835,18.972],[72.835,18.990],[72.836,19.010],[72.835,19.030]]},
            {"props":{"name":"Cross Street","class":"Secondary","lanes":2},"coords":[[72.820,19.000],[72.840,19.000],[72.860,19.000],[72.880,18.998]]},
            {"props":{"name":"East Road","class":"Collector","lanes":2},"coords":[[72.860,18.972],[72.862,18.985],[72.865,19.000],[72.868,19.015]]},
            {"props":{"name":"West Link","class":"Local","lanes":1},"coords":[[72.822,18.980],[72.822,18.995],[72.825,19.010]]},
        ]},
        {"name":"water_supply","type":"polyline","color":"#4DD0E1",
         "bounds":[72.825,18.975,72.878,19.012],"fields":["pipe_id","dia_mm","material"],
         "features":[
            {"props":{"pipe_id":"WS-001","dia_mm":300,"material":"DI"},"coords":[[72.825,18.980],[72.840,18.980],[72.855,18.981],[72.870,18.982]]},
            {"props":{"pipe_id":"WS-002","dia_mm":150,"material":"PVC"},"coords":[[72.840,18.975],[72.840,18.988],[72.840,19.000],[72.841,19.012]]},
            {"props":{"pipe_id":"WS-003","dia_mm":200,"material":"CI"},"coords":[[72.855,18.975],[72.860,18.988],[72.862,19.000]]},
            {"props":{"pipe_id":"WS-004","dia_mm":100,"material":"PVC"},"coords":[[72.870,18.985],[72.875,18.995],[72.878,19.005]]},
        ]},
        {"name":"sewerage_network","type":"polyline","color":"#A1887F",
         "bounds":[72.822,18.978,72.865,19.005],"fields":["pipe_id","dia_mm","gradient"],
         "features":[
            {"props":{"pipe_id":"SW-001","dia_mm":450,"gradient":"1:200"},"coords":[[72.822,18.985],[72.838,18.985],[72.852,18.986],[72.865,18.987]]},
            {"props":{"pipe_id":"SW-002","dia_mm":300,"gradient":"1:150"},"coords":[[72.838,18.978],[72.838,18.990],[72.839,19.003]]},
            {"props":{"pipe_id":"SW-003","dia_mm":225,"gradient":"1:100"},"coords":[[72.850,18.978],[72.853,18.992],[72.855,19.005]]},
        ]},
        {"name":"chambers","type":"point","color":"#CE93D8",
         "bounds":[72.835,18.980,72.880,19.008],"fields":["id","type","depth_m","condition"],
         "features":[
            {"props":{"id":"CH-001","type":"Inspection","depth_m":2.5,"condition":"Good"},"coords":[72.835,18.982]},
            {"props":{"id":"CH-002","type":"Junction","depth_m":3.0,"condition":"Fair"},"coords":[72.845,18.988]},
            {"props":{"id":"CH-003","type":"Inspection","depth_m":2.0,"condition":"Good"},"coords":[72.858,18.995]},
            {"props":{"id":"CH-004","type":"Terminal","depth_m":4.0,"condition":"Poor"},"coords":[72.870,18.980]},
            {"props":{"id":"CH-005","type":"Junction","depth_m":2.8,"condition":"Good"},"coords":[72.880,18.998]},
            {"props":{"id":"CH-006","type":"Inspection","depth_m":2.2,"condition":"Good"},"coords":[72.840,19.005]},
        ]},
        {"name":"utilities","type":"point","color":"#F06292",
         "bounds":[72.832,18.973,72.884,19.015],"fields":["id","type","status"],
         "features":[
            {"props":{"id":"HY-001","type":"Hydrant","pressure_bar":4.5,"status":"Active"},"coords":[72.832,18.978]},
            {"props":{"id":"HY-002","type":"Hydrant","pressure_bar":4.2,"status":"Active"},"coords":[72.848,18.985]},
            {"props":{"id":"VL-001","type":"Valve","dia_mm":150,"status":"Open"},"coords":[72.862,18.992]},
            {"props":{"id":"VL-002","type":"Valve","dia_mm":200,"status":"Closed"},"coords":[72.875,18.975]},
            {"props":{"id":"PS-001","type":"Pump Station","capacity_kl":500,"status":"Active"},"coords":[72.884,19.003]},
            {"props":{"id":"MH-001","type":"Manhole","depth_m":3.5,"status":"Active"},"coords":[72.842,19.008]},
            {"props":{"id":"MH-002","type":"Manhole","depth_m":2.8,"status":"Active"},"coords":[72.856,19.015]},
            {"props":{"id":"WT-001","type":"Water Tower","capacity_kl":500,"status":"Active"},"coords":[72.865,18.973]},
        ]},
    ]
    # Convert to proper GeoJSON
    def to_geojson(d):
        geom_type = "Polygon" if d["type"] == "polygon" else ("LineString" if d["type"] == "polyline" else "Point")
        features = []
        for f in d["features"]:
            features.append({
                "type": "Feature",
                "properties": f["props"],
                "geometry": {"type": geom_type, "coordinates": f["coords"]}
            })
        return {"type": "FeatureCollection", "features": features}

    with cache_lock:
        for d in raw:
            style = make_style(d["type"], d["color"])
            layer_cache[d["name"]] = dict(
                name=d["name"], type=d["type"],
                geojson=to_geojson(d),
                bounds=d["bounds"], count=len(d["features"]),
                fields=d["fields"], style=style,
                file_path=None, loaded_at=time.time()
            )
    print("[INFO] %d sample layers loaded" % len(raw))

if HAS_WATCHDOG:
    class SHPHandler(FileSystemEventHandler):
        def __init__(self):
            self._timers = {}
        def _debounce(self, path, delay=1.2):
            if path.endswith(".shp"):
                t = self._timers.get(path)
                if t: t.cancel()
                t = threading.Timer(delay, self._reload, [path])
                self._timers[path] = t
                t.start()
        def _reload(self, path):
            name = Path(path).stem
            d = load_shp(path)
            with cache_lock:
                if d:
                    d["style"] = make_style(d["type"], COLORS[len(layer_cache) % len(COLORS)])
                    layer_cache[name] = d
                    print("[WATCH] Updated: %s" % name)
                else:
                    layer_cache.pop(name, None)
        def on_created(self, e):
            if not e.is_directory: self._debounce(e.src_path)
        def on_modified(self, e):
            if not e.is_directory: self._debounce(e.src_path)
        def on_deleted(self, e):
            if not e.is_directory and e.src_path.endswith(".shp"):
                with cache_lock:
                    layer_cache.pop(Path(e.src_path).stem, None)


@app.route("/")
def index():
    return send_from_directory(str(FRONTEND_DIR), "index.html")

@app.route("/api/health")
def health():
    return jsonify(status="ok", layers=len(layer_cache))

@app.route("/api/layers")
def list_layers():
    with cache_lock:
        out = [dict(name=v["name"], type=v["type"], count=v["count"],
                    fields=v["fields"], bounds=v["bounds"], style=v["style"])
               for v in layer_cache.values()]
    return jsonify(layers=out, total=len(out))

@app.route("/api/layers/<name>")
def get_layer(name):
    with cache_lock:
        layer = layer_cache.get(name)
    if not layer:
        return jsonify(error="Not found"), 404
    return jsonify(name=layer["name"], type=layer["type"], count=layer["count"],
                   fields=layer["fields"], bounds=layer["bounds"],
                   style=layer["style"], geojson=layer["geojson"])

@app.route("/api/refresh", methods=["POST"])
def do_refresh():
    refresh_all()
    return jsonify(status="ok", layers=len(layer_cache))


def startup():
    refresh_all()
    if HAS_WATCHDOG:
        obs = Observer()
        obs.schedule(SHPHandler(), str(DATA_DIR), recursive=True)
        obs.daemon = True
        obs.start()
        print("[WATCH] Monitoring %s" % DATA_DIR)


startup()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print("[SERVER] http://localhost:%d" % port)
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
