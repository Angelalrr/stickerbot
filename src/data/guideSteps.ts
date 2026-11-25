export interface InstallStep {
  id: number;
  title: string;
  whereToClick: string;
  terminalName: string;
  command?: string;
  expectedOutput: string;
  howToVerify: string;
  ifError: string;
  link?: { label: string; url: string };
  conceptNote?: {
    term: string;
    explanation: string;
  };
}

export const INSTALL_STEPS: InstallStep[] = [
  {
    id: 1,
    title: 'Descargar y descomprimir StickerBot-Render.zip',
    whereToClick:
      'Haz clic en el botón "Descargar para Render" en la parte superior de esta página.\nGuarda StickerBot-Render.zip en tu computadora, haz clic derecho y elige "Extraer todo...".',
    terminalName: 'Explorador de Windows / Finder',
    expectedOutput:
      'Se crea la carpeta StickerBot-Render con Dockerfile, render.yaml, package.json, server.ts, server/ y src/.',
    howToVerify:
      'Verifica que dentro de la carpeta aparezcan el archivo Dockerfile y README.md en el primer nivel.',
    ifError:
      'Si el navegador bloquea la descarga, vuelve a pulsar "Descargar para Render" cuando el servidor haya terminado de iniciar.',
  },
  {
    id: 2,
    title: 'Subir la carpeta extraída a un repositorio en GitHub',
    whereToClick:
      'Crea un repositorio nuevo en GitHub (puede ser Private) y sube todos los archivos extraídos de StickerBot-Render.',
    terminalName: 'GitHub Web o Git en VS Code',
    command: 'git init && git add . && git commit -m "StickerBot Render"',
    expectedOutput:
      'Todos los archivos del proyecto quedan en la rama principal (main) de tu repositorio sin incluir node_modules ni .env.',
    howToVerify:
      'Entra a tu repositorio en github.com y confirma que Dockerfile y render.yaml son visibles en la raíz.',
    ifError:
      'Asegúrate de subir el contenido de la carpeta StickerBot-Render (no la carpeta comprimida .zip).',
    link: { label: 'Crear repositorio en GitHub', url: 'https://github.com/new' },
  },
  {
    id: 3,
    title: 'Crear base de datos gratuita en MongoDB Atlas (M0 Free)',
    whereToClick:
      'En MongoDB Atlas crea un clúster gratuito M0.\nEn Database Access crea un usuario y clave.\nEn Network Access permite la IP 0.0.0.0/0 para que Render pueda conectarse.',
    terminalName: 'MongoDB Atlas → Connect → Drivers',
    expectedOutput:
      'Obtienes una cadena de conexión parecida a mongodb+srv://usuario:clave@cluster.mongodb.net/stickerbot',
    howToVerify:
      'Guarda esa URL completa en un bloc temporal; la pegarás como variable MONGODB_URI en Render.',
    ifError:
      'Usa una contraseña sin símbolos especiales (@, :, /) para evitar problemas en la URL de conexión.',
    link: { label: 'Abrir MongoDB Atlas Free', url: 'https://www.mongodb.com/cloud/atlas/register' },
    conceptNote: {
      term: 'Por qué usar MongoDB Atlas',
      explanation:
        'El plan gratuito de Render reinicia el disco cada cierto tiempo. Guardar los usuarios, grupos autorizados y credenciales de WhatsApp en MongoDB Atlas evita tener que volver a escanear el QR.',
    },
  },
  {
    id: 4,
    title: 'Desplegar en Render (Plan Free con Docker)',
    whereToClick:
      'En Render haz clic en New + → Web Service, conecta tu repositorio de GitHub y selecciona:\n• Language: Docker\n• Instance Type: Free\n• Health Check Path: /health\nEn Environment Variables agrega NODE_ENV=production y MONGODB_URI.',
    terminalName: 'Panel de Render → Logs de despliegue',
    expectedOutput:
      'Render construye la imagen Docker con Node 22 y FFmpeg completo y muestra "Your service is live".',
    howToVerify:
      'Abre https://TU-APP.onrender.com/health en el navegador y confirma que responde {"status":"ok"}.',
    ifError:
      'Si falla el build, revisa en Render Settings que Dockerfile Path apunte a ./Dockerfile y Runtime sea Docker.',
    link: { label: 'Ir al panel de Render', url: 'https://dashboard.render.com' },
  },
  {
    id: 5,
    title: 'Configurar cron-job.org para evitar que Render se duerma',
    whereToClick:
      'Crea una cuenta gratuita en cron-job.org → Create Cronjob.\nPega la URL https://TU-APP.onrender.com/health y selecciona cada 10 minutos.',
    terminalName: 'cron-job.org → Cronjobs',
    expectedOutput:
      'Cada 10 minutos cron-job.org recibe HTTP 200 OK desde /health sin consumir base de datos ni tocar WhatsApp.',
    howToVerify:
      'En el historial de ejecuciones de cron-job.org aparece estado 200 OK en verde.',
    ifError:
      'Asegúrate de incluir https:// y terminar la URL exactamente en /health.',
    link: { label: 'Abrir cron-job.org', url: 'https://cron-job.org' },
  },
  {
    id: 6,
    title: 'Crear tu usuario, vincular WhatsApp y autorizar tu grupo',
    whereToClick:
      'Abre tu web desplegada en Render, entra a "Panel WhatsApp", crea tu usuario + PIN y vincula tu celular con Código QR o Código de 8 dígitos.\nLuego envía //pingdiag en tu grupo de WhatsApp y pulsa "Usar este grupo".',
    terminalName: 'Panel WhatsApp → Tu grupo',
    command: '//pingdiag',
    expectedOutput:
      'StickerBot responde con el ID del grupo (@g.us) y aparece listo para hacer clic en "Usar este grupo" dentro del panel.',
    howToVerify:
      'Envía /ping en ese grupo de WhatsApp y confirma que StickerBot responde normalmente.',
    ifError:
      'Si el código de 8 dígitos caduca, pulsa "Obtener código de 8 dígitos" nuevamente sin cerrar la pestaña.',
  },
];
