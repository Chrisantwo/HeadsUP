# Storm Forecasting Web App

This is the web version of the Storm Forecasting application. It provides the same functionality as the desktop version but runs in a web browser.

## Setup

1. Install the required dependencies:
```bash
pip install -r requirements.txt
```

2. Make sure you have the map images in the `resources/` folder:
   - `western_pacific_detailed_map.png`

## Running the Application

1. Start the Flask server:
```bash
python app.py
```

2. Open your web browser and navigate to:
```
http://localhost:5000
```

## Features

- **Date Input**: Enter a year (required), month (optional), and day (optional) to view typhoon data
- **Interactive Visualization**: View animated typhoon paths on a map of the Western Pacific
- **Controls**:
  - **PLAY/PAUSE**: Start or pause the animation
  - **>> 1 WEEK**: Skip forward one week in the simulation
  - **BACK TO MENU**: Return to the input screen

## Architecture

- **Backend**: Flask (Python) - handles data scraping and API endpoints
- **Frontend**: HTML/CSS/JavaScript with Canvas API for visualization
- **Data**: Typhoon data is scraped from NCICS IBTrACS database

## API Endpoints

- `GET /` - Main page
- `POST /api/typhoons` - Request typhoon data for a specific date
- `GET /api/typhoons/status` - Check if data is ready
- `GET /api/map` - Get the Western Pacific map image

## Notes

- The first time you request data for a year, it may take some time to scrape and process
- Data is cached in memory for faster subsequent requests
- The application focuses on the Western Pacific basin only

