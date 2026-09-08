#!/usr/bin/env python3
"""Compatibility entry point; implementation lives in proceedings/cvpr.py."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "proceedings"))
from cvpr import *  # noqa: F403

if __name__ == "__main__":
    sys.exit(main())  # noqa: F405
