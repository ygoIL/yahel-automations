FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-pil libraqm0 fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY . .
ENV NODE_ENV=production
CMD ["node", "server.js"]
