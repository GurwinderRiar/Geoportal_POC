# GeoPortal v2 — Full-Stack Spatial Intelligence Platform

## Quick Start

```bash
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # Mac/Linux
pip install -r requirements.txt
python app.py
```

Open: **http://localhost:5000**

## Tools

| Button | How to use |
|--------|-----------|
| **AREA** | Click vertices on map, **double-click** to finish → shows sq.m / sq.ft / ha / ac |
| **DIST** | Click points on map, **double-click** to finish → shows m / ft / km / mi |
| **BUFFER** | Click BUFFER → modal opens → **click map** to place centre → enter radius → Generate |
| **P2P** | Click two points → instant distance in m / ft / km |

## Deploy to Render

1. Push to GitHub
2. New Web Service on render.com
3. Root Dir: `backend` | Build: `pip install -r requirements.txt` | Start: `gunicorn app:app --workers 2 --bind 0.0.0.0:$PORT`

## Add Shapefiles

Drop `.shp + .shx + .dbf + .prj` into `backend/data/` — auto-detected on startup.
