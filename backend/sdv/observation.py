"""Contract metadata and observation direction, shared by inspection and exports."""
import json
from functools import lru_cache
from pathlib import Path
import cantools

CONTRACTS = Path(__file__).parents[1] / 'contracts'

@lru_cache
def catalog():
    result = json.loads((CONTRACTS / 'catalog.json').read_text())
    dbc = cantools.database.load_file(str(CONTRACTS / result['dbc']))
    for message in result['messages']:
        definition = dbc.get_message_by_frame_id(message['id'])
        message['signals'] = [
            {'name': signal.name, 'unit': signal.unit or '',
             'consumers': signal.receivers, 'vss': message.get('vss', {}).get(signal.name)}
            for signal in definition.signals
        ]
    return result

def endpoints(event):
    """CAN is a broadcast; only RX identifies an observed receiver."""
    kind = event.get('kind', '')
    observer = event.get('module', '')
    source = event.get('source', observer)
    if event.get('protocol') == 'CAN':
        if kind == 'tx': return observer, 'CAN bus', 'transmit'
        if kind == 'rx': return source, observer, 'receive'
    if event.get('protocol') == 'SOME/IP':
        if kind in ('request_tx', 'response_tx', 'event_tx'):
            return observer, 'navigation' if kind == 'request_tx' else 'controller', 'transmit'
        if kind in ('request_rx', 'response_rx', 'event_rx'):
            return source, observer, 'receive'
    return source, '', 'observation'

def signal_metadata(event, name):
    if event.get('protocol') == 'CAN':
        for message in catalog()['messages']:
            if message['id'] == event.get('message_id'):
                signal = next((s for s in message['signals'] if s['name'] == name), {})
                return message['name'], signal.get('unit', ''), signal.get('vss') or ''
    return 'NavigationIntent', {'target_speed': 'm/s', 'remaining': 'm'}.get(name, ''), ''
