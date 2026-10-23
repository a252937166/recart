FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=80
RUN adduser --disabled-password --uid 1000 agent && mkdir -p /data && chown agent:agent /data
COPY agent ./agent
USER agent
EXPOSE 80
CMD ["python", "-m", "agent.main"]
