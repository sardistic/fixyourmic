FROM node:20-slim

# Install streamlink and its dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    && python3 -m venv /opt/streamlink-venv \
    && /opt/streamlink-venv/bin/pip install --no-cache-dir streamlink \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Make streamlink available on PATH
ENV PATH="/opt/streamlink-venv/bin:$PATH"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
