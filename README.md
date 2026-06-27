# Storm Forecasting 🌀
Storm Forecasting is an animation engine that visualizes real-time tropical storm data of the past. It scrapes data from the [IBTRACS](https://ncics.org/ibtracs/index.php?name=browse-year-basin) website and filters the information by year and basin according to user input. It then displays an animation of tropical storms paths as they occur at the current time, accurate to every 3-hour interval.  

The application is available in two versions:
- **Desktop Application**: Pygame-based desktop application (`stormforecasting.py`)
- **Web Application**: Flask-based web application (`app.py`) that runs in your browser


## 🌟 Features
- **Western Pacific Focus**: Specialized visualization for the Western Pacific basin
- **Real-time Typhoon Tracking**: Visualizes typhoon paths with smooth animations
- **Dynamic Color Coding**: Changes typhoon colors based on intensity categories
- **Landfall Detection**: Automatically detects and marks typhoon landfall points
- **Detailed Information Display**: Shows typhoon names, wind speeds, and pressure data
- **Interactive Timeline**: Includes a time display that matches the simulation accurately
- **UI Elements**: Play / Pause, Skip 1 Week, Zoom to Philippines, and Return to Main Menu
- **Data Caching**: Stores previously webscraped data to your computer for faster retrieval
- **Dual Platform Support**: Available as both desktop (Pygame) and web (Flask) applications

## 🛠 Technical Components

### Map Generation (`map_maker.py`)
- Creates high-resolution maps of tropcial storm basins
- Utilizes Cartopy for accurate geographical projections
- Supports both detailed and simplified map versions
- Features include land masses, ocean, country borders, and basic elevation data

### Typhoon Data Scraper (`typhoon_scraper.py`)
- Scrapes typhoon data from Digital Typhoon database
- Extracts detailed track information including:
  - Position (latitude/longitude)
  - Wind speeds
  - Pressure data
  - Timestamps
- Caches data as a `.JSON` to `root/data` folder

### Visualization Engine (`stormforecasting.py`)
- Built with Pygame for smooth real-time animations
- Features include:
  - Rotating typhoon symbols
  - Color-coded intensity levels
  - Dynamic fade in/out effects
  - Landfall detection and marking
  - Time scaling for visualization
  - Pause / Play
  - Skip 1 Week

### Web Application (`app.py`)
- Built with Flask for web-based visualization
- Features include:
  - RESTful API endpoints for data retrieval
  - Background data scraping with status polling
  - HTML5 Canvas-based visualization
  - Interactive controls (Play/Pause, Skip, Zoom)
  - Responsive web interface
  - Real-time typhoon path visualization with directional indicators
  - Zoom functionality to focus on Philippines/PAR region
  - Legend showing typhoon category colors

## 🎨 Visualization Features

### Typhoon Representation
- **Symbol**: Animated rotating spiral with center dot
- **Color Coding**:
  ```python
  category_colors = {
      0: (135, 206, 235),  # Light Blue
      1: (100, 238, 100),  # Light Green
      2: (225, 225, 0),    # Yellow
      3: (255, 130, 0),    # Orange
      4: (255, 0, 0),      # Red
      5: (255, 0, 255)     # Purple
  }
  ```
- **Information Display**: Shows name, wind speed (kt), and pressure (hPa)

### Animation Effects
- Smooth fade-in/fade-out transitions
- Constant speed movement between track points
- Rotating blade animation
- Dynamic landfall markers with zoom effects


### Installing Prerequisites

#### Automatic Installation (Recommended)

**Windows:**
```bash
run.bat
```

**Linux/Mac/Git Bash:**
```bash
chmod +x run.sh
./run.sh
```

The script will automatically:
- Check for Python and pip installation
- Install all required packages from `requirements.txt`
- Generate the map if it doesn't exist
- Start the web application

#### Manual Installation

If you prefer to install manually:
```bash
pip install -r requirements.txt
```

Required packages:
- pygame (for desktop application)
- Flask (for web application)
- flask-cors (for web application)
- requests
- beautifulsoup4
- cartopy
- matplotlib
- numpy

### Running the Desktop Application
1. Generate the map (first run only):
   ```python
   python scripts/map_maker.py
   ```

2. Start the visualization:
   ```python
   python scripts/stormforecasting.py
   ```

### Running the Web Application
1. Generate the map (first run only):
   ```python
   python scripts/map_maker.py
   ```

2. Start the Flask server:
   ```python
   python app.py
   ```

3. Open your web browser and navigate to:
   ```
   http://localhost:5000
   ```

**Note**: The web application requires Flask and flask-cors. Make sure these are installed:
```bash
pip install Flask flask-cors
```

### Desktop Application Controls
- Click the "Play" button to start the animation
- Click the "Pause" button to pause the animation
- Click the "Skip 1 Week" button to jump 1 week forward into the timeline
- Click the "Return to Menu" button to regenerate an animation
- Close window to exit

### Web Application Controls
- **Submit**: Enter a year (required), month (optional), and day (optional) to load typhoon data
- **PLAY/PAUSE**: Start or pause the animation
- **>> 1 WEEK**: Skip forward one week in the simulation
- **ZOOM PH**: Toggle between full Western Pacific view and zoomed Philippines/PAR view
- **BACK TO MENU**: Return to the input screen to select a different date

## 📊 Data Structure

### Typhoon Object Format
```python
{
    "name": str,            # Typhoon name
    "path": [{
        "time": str,        # Format: "YYYY-MM-DD HH:MM"
        "lat": float,       # Latitude
        "long": float,      # Longitude
        "class": int,       # Intensity category (0-5)
        "speed": str,       # Wind speed in km/h
        "pressure": int     # Pressure in hPa
    }],
    "start_time": int       # Animation start time offset
}
```

## ⚙️ Configuration

Key parameters that can be adjusted:

```python
# Time scaling
TIME_SCALE_FACTOR = 1 / (12 * 60 * 60)  # 1 second = 12 hours

# Screen dimensions
SCREEN_WIDTH, SCREEN_HEIGHT = 1200, 900

# Animation parameters
fade_in_duration = 1
fade_out_duration = 0.5
fps_target = 120
```

## 🌐 Web Application API Endpoints

The web application (`app.py`) provides the following API endpoints:

- `GET /` - Main page (serves `templates/index.html`)
- `POST /api/typhoons` - Request typhoon data for a specific date
  - Request body: `{"year": int, "month": int (optional), "day": int (optional)}`
  - Returns: `{"status": "loading"}` (202) or `{"status": "success", "typhoons": [...], "earliest_time": "..."}` (200)
- `GET /api/typhoons/status` - Check if data is ready
  - Query parameters: `year`, `month`, `day`
  - Returns: `{"status": "ready"|"loading"|"not_found"|"error", ...}`
- `GET /api/map` - Get the Western Pacific detailed map image
- `GET /api/map/simple` - Get the Western Pacific simple map image (for landfall detection)


## 🙏 Acknowledgments

- Data source: [IBTRACS](https://ncics.org/ibtracs/index.php?name=browse-year-basin)
- Map data: Natural Earth via Cartopy


