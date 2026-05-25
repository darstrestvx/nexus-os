# YTS / YIFY – Stremio Addon

Addon de Stremio que permite navegar y reproducir películas de YTS/YIFY directamente desde Stremio mediante torrents magnet.

## Características

- 🎬 **4 catálogos**: Últimas, Populares, 4K/2160p, Mejor valoradas
- 🔍 **Búsqueda** de películas por título
- 🏷️ **Filtrado por género** (acción, comedia, drama, horror, etc.)
- 🔗 **Streams magnet** directos: 720p, 1080p, 2160p
- 📋 **Metadatos completos**: sinopsis, director, cast, rating IMDb, trailer
- ⚡ **Cache en memoria** (5 min) para respuestas más rápidas
- 📦 **Sin dependencias externas** — solo Node.js nativo

## Instalación

### Requisitos

- Node.js >= 14
- Stremio (desktop o web)

### Ejecución

```bash
node addon.js
```

El servidor inicia en el **puerto 5858**.

### Instalar en Stremio

**Opción 1 — URL directa:**
Abre en el navegador: `http://localhost:5858/` y haz clic en **"Instalar en Stremio"**

**Opción 2 — Manual:**
En Stremio → Addons → Instalar addon → ingresa:
```
http://localhost:5858/manifest.json
```

## API Endpoints

| Endpoint | Descripción |
|---|---|
| `GET /manifest.json` | Manifiesto del addon |
| `GET /catalog/movie/yts_latest.json` | Películas recientes |
| `GET /catalog/movie/yts_featured.json` | Populares |
| `GET /catalog/movie/yts_4k.json` | 4K |
| `GET /catalog/movie/yts_rating.json` | Mejor valoradas |
| `GET /catalog/movie/yts_latest/search=Batman.json` | Búsqueda |
| `GET /catalog/movie/yts_latest/genre=action.json` | Por género |
| `GET /meta/movie/{imdbId}.json` | Metadatos de película |
| `GET /stream/movie/{imdbId}.json` | Streams de película |

## Catálogos disponibles

| ID | Nombre | Orden |
|---|---|---|
| `yts_latest` | Últimas películas | Más recientes |
| `yts_featured` | Populares | Destacadas |
| `yts_4k` | 4K / 2160p | Más recientes en 4K |
| `yts_rating` | Mejor valoradas | Por rating IMDb |

## Paginación

Los catálogos soportan paginación vía el parámetro `skip`. Stremio lo maneja automáticamente.

## Fuente

El addon hace scraping de `en.yts-official.top` respetando la estructura HTML de la página.
