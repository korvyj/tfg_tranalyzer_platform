# Panel de estado de las sondas (FastAPI + uvicorn).
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

ENV DASH_PORT=8000
EXPOSE 8000
CMD ["python", "-m", "app.main"]
