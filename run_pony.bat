@echo off
title FjordFooocus - Pony V6
cd /d %~dp0

python -u launch.py --preset pony_v6 --listen

pause
