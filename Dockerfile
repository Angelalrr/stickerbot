FROM node:22-bookworm-slim

# Instalar FFmpeg completo (incluye libwebp, libopus y ffprobe) y certificados SSL
# Además: python3, pip, yt-dlp[default] (limite <=720p), gallery-dl (Pinterest/pin.it)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Instalar yt-dlp (con extras default: curl-cffi/EJS) y gallery-dl después de tener pip
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" gallery-dl

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install

# Runtime JS (deno) requerido por yt-dlp para resolver los retos de YouTube.
# Se instala vía npm para obtener el binario en PATH. Si falla, el build no se cae
# y el bot sigue funcionando con los sitios que no requieren JS runtime.
RUN npm install -g deno || echo "Aviso: no se pudo instalar deno (YouTube puede fallar)"

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
