#!/bin/bash

# Storm Forecasting - Automatic Installation and Run Script
# This script installs requirements and starts the web application

echo "🌀 Storm Forecasting - Installation and Startup Script"
echo "=================================================="
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    if ! command -v python &> /dev/null; then
        echo "❌ Error: Python is not installed or not in PATH"
        echo "Please install Python 3.7 or higher from https://www.python.org/"
        exit 1
    else
        PYTHON_CMD="python"
    fi
else
    PYTHON_CMD="python3"
fi

echo "✓ Python found: $($PYTHON_CMD --version)"
echo ""

# Check if pip is installed
if ! command -v pip3 &> /dev/null; then
    if ! command -v pip &> /dev/null; then
        echo "❌ Error: pip is not installed"
        echo "Please install pip first"
        exit 1
    else
        PIP_CMD="pip"
    fi
else
    PIP_CMD="pip3"
fi

echo "✓ pip found: $($PIP_CMD --version)"
echo ""

# Install requirements
echo "📦 Installing requirements..."
echo "This may take a few minutes..."
echo ""

$PIP_CMD install -r requirements.txt

if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Error: Failed to install requirements"
    echo "Please check the error messages above"
    exit 1
fi

echo ""
echo "✓ Requirements installed successfully!"
echo ""

# Check if map exists
if [ ! -f "resources/western_pacific_detailed_map.png" ]; then
    echo "⚠️  Warning: Map file not found!"
    echo "Generating map (this may take a few minutes)..."
    echo ""
    $PYTHON_CMD scripts/map_maker.py
    
    if [ $? -ne 0 ]; then
        echo ""
        echo "❌ Error: Failed to generate map"
        echo "Please run 'python scripts/map_maker.py' manually"
        exit 1
    fi
    
    echo ""
    echo "✓ Map generated successfully!"
    echo ""
fi

# Start the Flask application
echo "🚀 Starting Storm Forecasting web application..."
echo ""
echo "The application will be available at: http://localhost:5000"
echo "Press Ctrl+C to stop the server"
echo ""
echo "=================================================="
echo ""

$PYTHON_CMD app.py

