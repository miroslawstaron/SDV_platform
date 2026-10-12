import logging
import time
import httpx
from kuksa_client.grpc import VSSClient, Datapoint
logging.basicConfig(level=logging.INFO)
def main():
    while True:
        try:
            with VSSClient('kuksa',55555) as broker, httpx.Client(timeout=3) as http:
                while True:
                    signals=http.get('http://api:8000/api/v1/telemetry').json()['signals']
                    mapping={'Vehicle.Speed':signals.get('Speed',0)*3.6,'Vehicle.CurrentLocation.Latitude':signals.get('Latitude',0),'Vehicle.CurrentLocation.Longitude':signals.get('Longitude',0),'Vehicle.Powertrain.TractionBattery.StateOfCharge.Current':signals.get('Charge',0),'Vehicle.Powertrain.TractionBattery.StateOfCharge.CurrentEnergy':signals.get('Energy',0)/1000}
                    if signals:broker.set_current_values({path:Datapoint(value) for path,value in mapping.items()})
                    http.post('http://api:8000/api/v1/gateway/status',json={'status':'ready','paths':list(mapping)})
                    time.sleep(.2)
        except Exception as exc:
            logging.warning('KUKSA gateway reconnecting: %s',exc)
            try:httpx.post('http://api:8000/api/v1/gateway/status',json={'status':'unavailable','error':str(exc)},timeout=2)
            except Exception:pass
            time.sleep(2)
if __name__=='__main__':main()
