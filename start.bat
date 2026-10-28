@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Creating virtual environment...
  py -m venv .venv || python -m venv .venv
)
call .venv\Scripts\activate
python -m pip install --disable-pip-version-check -q -r requirements.txt
python run.py
pause
