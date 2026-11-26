FROM node:22-bookworm-slim

# Instalar FFmpeg completo (incluye libwebp, libopus y ffprobe) y certificados SSL
# Además: python3, pip, yt-dlp (limite <=720p), gallery-dl (Pinterest/pin.it), curl-cffi
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Instalar yt-dlp y gallery-dl después de tener pip
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp gallery-dl

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
