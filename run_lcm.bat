@echo off
title FjordFooocus - LCM (Fast)
cd /d %~dp0

python -u launch.py --preset lcm --listen

pause
