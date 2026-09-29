import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.server import app  # noqa: F401,E402
