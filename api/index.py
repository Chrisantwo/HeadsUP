import sys
import os

# Make backend/ importable from this serverless function
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend'))

from app import app  # Vercel uses the WSGI 'app' object as the request handler
