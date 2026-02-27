@echo off
title FjordFooocus - Lightning (Fast)
cd /d %~dp0

python -u launch.py --preset lightning --listen

pause
