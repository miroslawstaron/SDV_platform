"""Persistent street-image captures and 64-bit DCT perceptual hash matching."""
import hashlib
import io
import math
import sqlite3
import statistics
import time
from contextlib import contextmanager
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

DBPATH = Path('/data/images.sqlite')
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
HASH_BITS = 64
MAX_DISTANCE = 8
WARNING_COUNT = 5
# First eight frequencies of the unnormalised separable 32-point DCT-II.
COSINES = [[math.cos(math.pi * (2*x+1) * u / 64) for x in range(32)] for u in range(8)]


def phash(data: bytes) -> tuple[str, str]:
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError('Image must contain between 1 byte and 12 MiB')
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in ('JPEG', 'PNG', 'WEBP'):
                raise ValueError('Use a JPEG, PNG or WebP image')
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError('Image exceeds 20 million pixels')
            media_type = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}[image.format]
            pixels = list(ImageOps.exif_transpose(image).convert('L').resize((32, 32), Image.Resampling.LANCZOS).getdata())
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError('Image could not be decoded') from exc
    rows = [[sum(pixels[y*32+x] * COSINES[u][x] for x in range(32)) for u in range(8)] for y in range(32)]
    coefficients = [sum(rows[y][u] * COSINES[v][y] for y in range(32)) for v in range(8) for u in range(8)]
    # Suppress floating point DCT noise for flat images and exact symmetry.
    coefficients = [0.0 if abs(value) < 1e-7 else value for value in coefficients]
    median = statistics.median(coefficients)
    bits = 0
    for value in coefficients:
        bits = (bits << 1) | int(value > median)
    return f'{bits:016x}', media_type


@contextmanager
def connection():
    db = sqlite3.connect(DBPATH, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize():
    DBPATH.parent.mkdir(parents=True, exist_ok=True)
    with connection() as db:
        db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS images (
                id TEXT PRIMARY KEY, phash TEXT NOT NULL, media_type TEXT NOT NULL,
                data BLOB NOT NULL, created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS captures (
                run_id TEXT NOT NULL, station_index INTEGER NOT NULL,
                image_id TEXT NOT NULL REFERENCES images(id),
                provider_image_id TEXT NOT NULL, sim_time REAL NOT NULL,
                lat REAL NOT NULL, lng REAL NOT NULL, captured_at REAL,
                PRIMARY KEY (run_id, station_index)
            );
            CREATE INDEX IF NOT EXISTS captures_image ON captures(image_id);
            CREATE INDEX IF NOT EXISTS images_phash ON images(phash, created_at, id);
        ''')


def store_image(db, data, hash_value, media_type):
    # Called under BEGIN IMMEDIATE: concurrent 100% matches cannot both insert.
    match = db.execute('SELECT id FROM images WHERE phash=? ORDER BY created_at,id LIMIT 1', (hash_value,)).fetchone()
    if match:
        return match['id'], False
    image_id = hashlib.sha256(data).hexdigest()
    db.execute('INSERT INTO images VALUES(?,?,?,?,?)', (image_id, hash_value, media_type, data, time.time()))
    return image_id, True


def capture(run_id, station_index, data, provider_image_id, sim_time, lat, lng, captured_at=None):
    hash_value, media_type = phash(data)
    with connection() as db:
        # Serialise duplicate driver windows/retries into one capture per station.
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('''SELECT c.image_id,i.phash FROM captures c JOIN images i ON i.id=c.image_id
                                 WHERE c.run_id=? AND c.station_index=?''', (run_id, station_index)).fetchone()
        if existing:
            if existing['phash'] != hash_value:
                raise ValueError('This station already has a different captured image')
            image_id = existing['image_id']
        else:
            image_id, _ = store_image(db, data, hash_value, media_type)
        db.execute('INSERT OR IGNORE INTO captures VALUES(?,?,?,?,?,?,?,?)',
                   (run_id, station_index, image_id, provider_image_id, sim_time, lat, lng, captured_at))
    return similarity(run_id, station_index)


def capture_metadata(row):
    value=dict(row)
    value['source']='uploaded' if value['run_id'].startswith('library-') else 'mapillary'
    if value['source']=='uploaded':value.update(lat=None,lng=None)
    return value


def similarity(run_id, station_index, offset=0, limit=5, matches_only=True):
    with connection() as db:
        db.execute('BEGIN')
        total = db.execute('SELECT COUNT(*) FROM images').fetchone()[0]
        capture_total = db.execute('SELECT COUNT(*) FROM captures').fetchone()[0]
        current = db.execute('''SELECT c.*, i.phash FROM captures c JOIN images i ON i.id=c.image_id
                                WHERE c.run_id=? AND c.station_index=?''', (run_id, station_index)).fetchone()
        base = {'run_id': run_id, 'station_index': station_index, 'database_images': total,
                'database_captures': capture_total, 'count_basis': 'captures',
                'hash_bits': HASH_BITS, 'max_distance': MAX_DISTANCE, 'warning_count': WARNING_COUNT}
        if not current:
            return dict(base, status='awaiting_capture', similar_count=0, similar_image_count=0,
                        too_similar=False, nearest_similarity_pct=None, matches=[], comparisons=[], comparison_total=0)
        current=capture_metadata(current)
        query_hash = int(current['phash'], 16)
        count = 0
        nearest = None
        similar_images = set()
        comparisons = []
        # Storage deduplication must not hide earlier captures of the same asset.
        # Exclude this observation (run + station), not its shared image_id.
        for row in db.execute('''SELECT c.*, i.phash FROM captures c JOIN images i ON i.id=c.image_id
                                 WHERE NOT (c.run_id=? AND c.station_index=?)''', (run_id, station_index)):
            distance = (query_hash ^ int(row['phash'], 16)).bit_count()
            nearest = distance if nearest is None else min(nearest, distance)
            if distance <= MAX_DISTANCE:
                count += 1
                similar_images.add(row['image_id'])
            if not matches_only or distance <= MAX_DISTANCE:
                comparisons.append(dict(capture_metadata(row), distance=distance, similarity_pct=(HASH_BITS-distance)/HASH_BITS*100,
                                        is_match=distance <= MAX_DISTANCE, exact_image=row['image_id']==current['image_id']))
        comparisons.sort(key=lambda item: (item['distance'], item['run_id'], item['station_index']))
        matches = [item for item in comparisons if item['is_match']][:5]
        return dict(base, status='ready', image_id=current['image_id'], phash=current['phash'],
                    provider_image_id=current['provider_image_id'], sim_time=current['sim_time'],
                    source=current['source'],
                    lat=current['lat'], lng=current['lng'], captured_at=current['captured_at'],
                    similar_count=count, similar_image_count=len(similar_images), too_similar=count >= WARNING_COUNT,
                    nearest_similarity_pct=None if nearest is None else (HASH_BITS-nearest)/HASH_BITS*100,
                    matches=matches, comparison_total=len(comparisons), comparisons=comparisons[offset:offset+limit])


def list_captures(run_id=None, offset=0, limit=24):
    with connection() as db:
        db.execute('BEGIN')
        where = "WHERE c.run_id LIKE 'library-%'" if run_id=='reference-library' else 'WHERE c.run_id=?' if run_id else ''
        params = (run_id,) if run_id and run_id!='reference-library' else ()
        total = db.execute(f'SELECT COUNT(*) FROM captures c {where}', params).fetchone()[0]
        items = [capture_metadata(row) for row in db.execute(f'''SELECT c.*, i.phash, i.media_type,
                     length(i.data) AS bytes FROM captures c JOIN images i ON i.id=c.image_id
                     {where} ORDER BY c.rowid DESC LIMIT ? OFFSET ?''', (*params, limit, offset))]
        runs = [dict(row) for row in db.execute('''SELECT CASE WHEN run_id LIKE 'library-%' THEN 'reference-library' ELSE run_id END AS run_id,
                    COUNT(*) AS captures FROM captures GROUP BY CASE WHEN run_id LIKE 'library-%' THEN 'reference-library' ELSE run_id END
                    ORDER BY MAX(rowid) DESC''')]
        image_total = db.execute('SELECT COUNT(*) FROM images').fetchone()[0]
        capture_total = db.execute('SELECT COUNT(*) FROM captures').fetchone()[0]
    return {'total': total, 'items': items, 'runs': runs, 'database_images': image_total,
            'database_captures': capture_total, 'offset': offset, 'limit': limit}


def list_images(offset=0, limit=50):
    with connection() as db:
        db.execute('BEGIN')
        total = db.execute('SELECT COUNT(*) FROM images').fetchone()[0]
        items = [dict(row) for row in db.execute('''SELECT i.id, i.phash, i.media_type, i.created_at,
                    length(i.data) AS bytes, (SELECT COUNT(*) FROM captures c WHERE c.image_id=i.id) AS captures,
                    (SELECT provider_image_id FROM captures c WHERE c.image_id=i.id AND c.run_id LIKE 'library-%' LIMIT 1) AS reference_label
                    FROM images i ORDER BY i.created_at DESC, i.id LIMIT ? OFFSET ?''', (limit, offset))]
    return {'total': total, 'items': items}


def image_bytes(image_id):
    with connection() as db:
        row = db.execute('SELECT data, media_type FROM images WHERE id=?', (image_id,)).fetchone()
    return (row['data'], row['media_type']) if row else None


def import_image(data, filename):
    """Reuse 100% matches and keep one library reference per stored image."""
    hash_value, media_type = phash(data)
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        image_id, stored = store_image(db, data, hash_value, media_type)
        added = db.execute('INSERT OR IGNORE INTO captures VALUES(?,?,?,?,?,?,?,?)',
                           ('library-'+image_id, 0, image_id, filename, 0, 0, 0, None)).rowcount
        total = db.execute('SELECT COUNT(*) FROM images').fetchone()[0]
    return {'image_id': image_id, 'phash': hash_value, 'source': 'uploaded',
            'database_images': total, 'image_stored': stored, 'reference_added': bool(added)}


def statistics_summary():
    with connection() as db:
        row = db.execute('SELECT COUNT(*) AS images, COALESCE(SUM(length(data)),0) AS image_bytes FROM images').fetchone()
        captures = db.execute('SELECT COUNT(*) FROM captures').fetchone()[0]
        references = db.execute("SELECT COUNT(*) FROM captures WHERE run_id LIKE 'library-%'").fetchone()[0]
        pages = db.execute('PRAGMA page_count').fetchone()[0]
        free = db.execute('PRAGMA freelist_count').fetchone()[0]
        page_size = db.execute('PRAGMA page_size').fetchone()[0]
    return dict(row, captures=captures, references=references, database_bytes=pages*page_size,
                reusable_bytes=free*page_size, hash_bits=HASH_BITS,
                max_distance=MAX_DISTANCE, warning_count=WARNING_COUNT)


def delete_images(image_ids=None):
    """Remove assets and every referencing observation in one transaction."""
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        if image_ids is None:
            captures = db.execute('DELETE FROM captures').rowcount
            images = db.execute('DELETE FROM images').rowcount
        else:
            image_ids = list(set(image_ids))
            placeholders = ','.join('?' for _ in image_ids)
            found = db.execute(f'SELECT COUNT(*) FROM images WHERE id IN ({placeholders})', image_ids).fetchone()[0]
            if found != len(image_ids):
                raise KeyError('An image no longer exists. Refresh the dashboard.')
            captures = db.execute(f'DELETE FROM captures WHERE image_id IN ({placeholders})', image_ids).rowcount
            images = db.execute(f'DELETE FROM images WHERE id IN ({placeholders})', image_ids).rowcount
    return {'images_deleted': images, 'captures_deleted': captures}


def delete_run_captures(run_ids):
    if not run_ids:return {'images_deleted':0,'captures_deleted':0}
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        placeholders = ','.join('?' for _ in run_ids)
        affected = [row[0] for row in db.execute(f'SELECT DISTINCT image_id FROM captures WHERE run_id IN ({placeholders})', run_ids)]
        captures = db.execute(f'DELETE FROM captures WHERE run_id IN ({placeholders})', run_ids).rowcount
        # Shared assets, including uploaded references, remain while still used.
        images = 0
        for image_id in affected:
            images += db.execute('DELETE FROM images WHERE id=? AND NOT EXISTS (SELECT 1 FROM captures WHERE image_id=?)', (image_id,image_id)).rowcount
    return {'images_deleted': images, 'captures_deleted': captures}
