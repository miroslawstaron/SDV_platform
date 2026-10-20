"""Local, bounded English scenario interpreter and persistent scenario library.

Only the structured settings are executable. Prompts never become Python, shell
commands, or CARLA API calls; unmatched instructions remain visible for review.
"""
from contextlib import contextmanager
import json
from pathlib import Path
import re
import sqlite3
import time
import uuid

from .models import DrivingScenarioSettings, ScenarioPrompt

DBPATH = Path('/data/driving-scenarios.sqlite')
WORDS = dict(zip('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred'.split(),
                 [*range(21), 30, 40, 50, 60, 70, 80, 90, 100]))
NUMBER = r'(?:\d+(?:\.\d+)?|' + '|'.join(WORDS) + r'|no)'
FILLER = set('a an the i my we our want would like please create make scenario drive driving carla town10 town10hd town10hd_opt city urban town street streets road roads route trip test simulation simulate with without and or in on at for to of is are be have has some through around along under during conditions weather time limit cap maximum max target speed length distance duration traffic walking surrounding pedestrians vehicles cars people settings population include use default minutes seconds meters metres kmh kph km h m s per start end daytime'.split())


def number(value):
    if value in WORDS:return WORDS[value]
    return 0 if value == 'no' else float(value)


def interpret(prompt):
    """Return supported settings plus *all* substantive unmatched words."""
    text = prompt.lower().replace('–', '-').replace('×', 'x')
    if re.search(r'(?<!\w)-\s*\d', text):raise ValueError('Scenario values cannot be negative.')
    if re.search(r'(?<![\w.])\.\d', text):raise ValueError('Write decimals with a leading zero, for example 0.5 km.')
    text = re.sub(r'\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -](one|two|three|four|five|six|seven|eight|nine)\b',
                  lambda m: str(WORDS[m[1]] + WORDS[m[2]]), text)
    claimed = [False] * len(text)
    values = {}
    priority = {}

    def scan(pattern, fields, rank=100):
        for match in re.finditer(pattern, text):
            if any(claimed[match.start():match.end()]):continue
            assigned = fields(match) if callable(fields) else fields
            for key, value in assigned.items():
                if rank == priority.get(key) and values[key] != value:
                    raise ValueError(f'Conflicting instructions for {key.replace("_", " ")}. Specify one value.')
                if rank >= priority.get(key, -1):values[key], priority[key] = value, rank
            claimed[match.start():match.end()] = [True] * (match.end() - match.start())

    scan(r'\b(?:no|without)\s+(?:pedestrian\s+)?crossings?\b', {'crossings': 'none'})
    scan(r'\b(?:frequent|many|lots of)\s+(?:pedestrian\s+)?crossings?\b', {'crossings': 'frequent'})
    scan(r'\b(?:pedestrian crossings?|crossing pedestrians?)\b', {'crossings': 'normal'})
    scan(rf'\b({NUMBER})\s+(?:walking\s+)?(?:pedestrians?|walkers?|people)\b', lambda m: {'pedestrians': number(m[1])})
    scan(r'\b(?:without)\s+(?:pedestrians?|walkers?|people)\b', {'pedestrians': 0})
    scan(rf'\b({NUMBER})\s+(?:traffic\s+|other\s+)?(?:cars?|vehicles?)\b', lambda m: {'traffic_vehicles': number(m[1])})
    scan(r'\b(?:no|without)\s+traffic\b|\bempty roads\b', {'traffic_vehicles': 0})
    scan(rf'\b({NUMBER})\s*(km\s*/\s*h|kmh|kph|km per hour|kilomet(?:er|re)s? per hour|mph)\b',
         lambda m: {'speed_kmh': round(number(m[1]) * (1.609344 if m[2] == 'mph' else 1), 3)})
    scan(rf'\b({NUMBER})\s*(kilomet(?:er|re)s?|km|met(?:er|re)s?|m|miles?)\b(?!\s*(?:/|per))',
         lambda m: {'distance_m': number(m[1]) * (1000 if m[2].startswith(('km', 'kilo')) else 1609.344 if m[2].startswith('mile') else 1)})
    scan(rf'\b({NUMBER})\s*(minutes?|mins?|seconds?|secs?|s)\b',
         lambda m: {'duration_seconds': number(m[1]) * (60 if m[2].startswith('m') else 1)})
    scan(r'\bseed\s*[:=]?\s*(\d+)\b', lambda m: {'seed': int(m[1])})
    for pattern, fields in [
        (r'\b(?:busy|crowded) city\b', {'pedestrians': 80, 'traffic_vehicles': 24}),
        (r'\bquiet city\b', {'pedestrians': 8, 'traffic_vehicles': 2}),
        (r'\b(?:heavy|busy|dense) traffic\b', {'traffic_vehicles': 24}),
        (r'\blight traffic\b', {'traffic_vehicles': 4}),
        (r'\b(?:many|lots of) pedestrians\b', {'pedestrians': 80}),
        (r'\b(?:few|a few) pedestrians\b', {'pedestrians': 8}),
    ]:scan(pattern, fields, rank=10)
    for pattern, weather in [
        (r'\b(?:no rain|without rain|clear|sunny|dry)\b', 'clear'),
        (r'\b(?:heavy rain|heavy rainfall|stormy)\b', 'heavy_rain'),
        (r'\b(?:light rain|drizzle|drizzling)\b', 'light_rain'),
        (r'\b(?:rain|rainy|raining)\b', 'rain'),
        (r'\b(?:cloudy|overcast)\b', 'cloudy'),
        (r'\b(?:wet)\b', 'wet'),
        (r'\b(?:fog|foggy)\b', 'fog'),
    ]:scan(pattern, {'weather': weather})
    scan(r'\b(?:night|nighttime|midnight)\b', {'time_of_day': 'night'})
    scan(r'\b(?:sunset|dusk|evening)\b', {'time_of_day': 'sunset'})
    scan(r'\b(?:day|daytime|noon|midday|morning)\b', {'time_of_day': 'day'})
    remaining = ''.join(' ' if used else char for used, char in zip(claimed, text))
    unknown = list(dict.fromkeys(word for word in re.findall(r"[\w']+", remaining) if word not in FILLER))
    if not values:raise ValueError('No supported scenario settings found. Try: 20 pedestrians, 4 cars, 25 km/h, rain at sunset, 500 m, for 2 minutes.')
    # Validate requested values instead of silently clamping them to limits.
    settings = DrivingScenarioSettings.model_validate(values)
    return {'settings': settings.model_dump(), 'unrecognized': unknown,
            'notes': ['Town10HD city route; named destinations and scripted turns are not supported.',
                      'Weather changes the scene appearance; tire grip is unchanged.',
                      'Pedestrian crossings are probabilistic; exact actor actions and timing are not scripted.',
                      'Unspecified settings use the values in this preview. Actual actor counts can be lower if spawning fails.']}


@contextmanager
def connection():
    DBPATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DBPATH, timeout=10)
    try:
        with db:
            db.execute('CREATE TABLE IF NOT EXISTS scenarios(id TEXT PRIMARY KEY, updated REAL NOT NULL, data TEXT NOT NULL)')
            yield db
    finally:db.close()


def list_scenarios():
    with connection() as db:return [json.loads(row[0]) for row in db.execute('SELECT data FROM scenarios ORDER BY updated DESC')]


def get_scenario(sid):
    with connection() as db:row = db.execute('SELECT data FROM scenarios WHERE id=?', (sid,)).fetchone()
    if not row:raise KeyError('Scenario not found')
    return json.loads(row[0])


def save_scenario(data:ScenarioPrompt, sid=None):
    compiled = interpret(data.prompt)
    if compiled['unrecognized'] and not data.accept_unrecognized:
        raise ValueError('Review the unrecognized instructions and choose "Use recognized settings only" before saving.')
    if not data.name.strip():raise ValueError('Enter a scenario name')
    if sid:get_scenario(sid)
    value = {'id': sid or str(uuid.uuid4()), 'name': data.name.strip(), 'prompt': data.prompt.strip(),
             'settings': compiled['settings'], 'unrecognized': compiled['unrecognized']}
    with connection() as db:
        db.execute('INSERT INTO scenarios VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data',
                   (value['id'], time.time(), json.dumps(value)))
    return value


def delete_scenario(sid):
    with connection() as db:
        if not db.execute('DELETE FROM scenarios WHERE id=?', (sid,)).rowcount:raise KeyError('Scenario not found')


def weather_parameters(settings):
    weather = settings.get('weather', 'clear')
    parameters = {'cloudiness': 5, 'sun_altitude_angle': {'day': 75, 'sunset': 5, 'night': -30}[settings.get('time_of_day', 'day')]}
    parameters.update({
        'clear': {}, 'cloudy': {'cloudiness': 90}, 'wet': {'wetness': 80, 'precipitation_deposits': 60},
        'light_rain': {'cloudiness': 70, 'precipitation': 20, 'wetness': 50, 'precipitation_deposits': 20},
        'rain': {'cloudiness': 85, 'precipitation': 50, 'wetness': 80, 'precipitation_deposits': 50},
        'heavy_rain': {'cloudiness': 100, 'precipitation': 85, 'wetness': 100, 'precipitation_deposits': 85},
        'fog': {'cloudiness': 70, 'fog_density': 60, 'fog_distance': 10, 'fog_falloff': .2},
    }[weather])
    return parameters
