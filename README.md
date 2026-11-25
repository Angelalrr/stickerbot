# StickerBot — Bot de WhatsApp Multi-Usuario listo para Render (Plan Free + Docker)

Bot completo de WhatsApp Web basado en **@whiskeysockets/baileys v7 (ESM)**, **Sharp**, **FFmpeg** y un **panel web multi-usuario** unificado en Node.js + Express + React.

Cada persona puede crear su propio usuario con PIN en la página web, vincular su cuenta de WhatsApp mediante **código QR** o **código de emparejamiento de 8 dígitos**, descubrir el ID de su grupo con `//pingdiag` y activar el bot únicamente en ese grupo autorizado.

Además, la pestaña **Creador** del panel web permite crear stickers sin comandos: elige una **foto** (con recorte cuadrado libre), un **video o GIF** (con recorte temporal del fragmento, hasta los 10 segundos que permite WhatsApp para stickers animados y opción de Sound Sticker con audio) o un **texto** con color, y envíalo directamente al grupo seleccionado con el botón **Enviar a WhatsApp**.

---

## Comandos disponibles en WhatsApp

- `/menu` — Lista todos los comandos y ejemplos rápidos.
- `/ayuda` — Guía rápida de uso.
- `/ping` — Verifica si el bot está activo en el grupo.
- `//pingdiag` — Muestra el ID (`...@g.us`) del grupo actual para configurarlo en tu panel web.
- `/info` — Muestra límites, estado de FFmpeg y Sound Stickers nativos.
- `/version` — Versión de StickerBot, Node.js y Baileys v7.
- `/cancelar` — Cancela una conversión de video en proceso.
- `/sticker` o `/s` — Convierte una foto (PNG/JPG/WebP) en sticker 512×512 conservando transparencia.
- `/stickertexto <texto>` — Crea un sticker transparente con texto, color opcional y contorno.
- `/gif` o `/stickeranimado` — Convierte videos cortos o GIFs en stickers animados WebP (< 500 KB), con recorte cuadrado centrado automático. Añade `completo` o `-full` para conservar toda la proporción sin recortar bordes.
- `/stickeraudio` — Convierte un video con audio en un único **Sound Sticker nativo** sincronizado (con icono de sonido y reproducción al pulsar). También admite `completo` o `-full`.

---

## Guía paso a paso para desplegar gratis en Render

### Paso 1: Subir el proyecto a GitHub
1. Crea una cuenta gratuita en [github.com](https://github.com) si aún no tienes una.
2. Crea un repositorio nuevo (puede ser **Private** para mayor orden) sin inicializarlo con README.
3. Sube todos los archivos de la carpeta del proyecto (asegúrate de que `Dockerfile`, `package.json`, `render.yaml` y `server.ts` queden en la raíz del repositorio). Nunca subas archivos `.env` ni carpetas `auth_*`.

### Paso 2: Crear una base de datos gratuita en MongoDB Atlas
Render Free reinicia el disco cada cierto tiempo. Con MongoDB Atlas gratuito (M0, 512 MB), tus usuarios, grupos autorizados y sesiones de WhatsApp **no se pierden**:
1. Entra a [mongodb.com/atlas](https://www.mongodb.com/atlas) y crea un clúster gratuito (**M0 Free**).
2. En **Database Access**, crea un usuario y contraseña (sin caracteres especiales raros para no complicar la URL).
3. En **Network Access**, añade `0.0.0.0/0` (necesario para que Render pueda conectarse).
4. En **Connect → Drivers**, copia tu cadena de conexión (`mongodb+srv://usuario:clave@cluster...mongodb.net/stickerbot?retryWrites=true&w=majority`).

### Paso 3: Desplegar con Docker en Render (Plan Free)
1. Inicia sesión en [render.com](https://render.com) con tu cuenta de GitHub.
2. Haz clic en **New + → Web Service** y selecciona tu repositorio de StickerBot.
3. En **Language / Runtime**, elige **Docker** (Render detectará automáticamente el `Dockerfile`).
4. En **Instance Type**, selecciona **Free**.
5. En **Health Check Path**, escribe `/health`.
6. En **Environment Variables**, añade:
   - `NODE_ENV` = `production`
   - `MONGODB_URI` = *(pega aquí tu enlace de MongoDB Atlas del Paso 3)*
7. Haz clic en **Create Web Service** y espera unos minutos a que Render construya la imagen Docker (incluye Node 22 y FFmpeg completo).

### Paso 4: Mantener despierto Render Free con cron-job.org
El plan gratuito de Render entra en reposo tras 15 minutos sin tráfico HTTP. Para evitar que se duerma:
1. Crea una cuenta gratuita en [cron-job.org](https://cron-job.org).
2. Haz clic en **Create Cronjob**.
3. En **URL**, pega tu ruta de salud: `https://TU-SERVICIO.onrender.com/health`
4. En **Execution schedule**, configúralo cada **10 minutos** (o cada 12–14 minutos).
5. Guarda y activa el cronjob. El endpoint `/health` responde `200 OK` al instante sin tocar WhatsApp ni la base de datos.

### Paso 5: Vincular tu WhatsApp desde el panel web
1. Abre tu URL de Render (`https://TU-SERVICIO.onrender.com`).
2. Entra a la pestaña **Panel WhatsApp** y registra tu usuario + PIN.
3. Elige **Código QR** o **Código de 8 dígitos** (escribiendo tu número con código de país, por ejemplo `51999888777` sin `+`) y vincúlalo en **WhatsApp → Dispositivos vinculados**.
4. Entra al grupo de WhatsApp donde quieres usar el bot y envía `//pingdiag`.
5. Copia el ID (`120363...@g.us`) que aparecerá en tu panel (o en la respuesta del grupo) y guárdalo como grupo autorizado. ¡Listo!

---

## Ejecución local para pruebas

```bash
npm install
npm run dev
```

Abre `http://localhost:3000` en tu navegador.
