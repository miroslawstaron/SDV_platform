from typing import Literal
from pydantic import BaseModel, Field, model_validator

ROLES = ('navigation','controller','powertrain','brake','lane','sensor','bms')

class Selection(BaseModel):
    ids: list[str] | None = Field(None, min_length=1, max_length=500)
    all: bool = False

    @model_validator(mode='after')
    def validate_selection(self):
        if bool(self.ids) == self.all:
            raise ValueError('Choose selected IDs or explicitly select all')
        return self

class Point(BaseModel):
    lat: float = Field(ge=-85, le=85)
    lng: float = Field(ge=-180, le=180)

class RouteRequest(BaseModel):
    start: Point
    destination: Point
    left_hand: bool = False

class Vehicle(BaseModel):
    length: float = Field(4.5, gt=0, le=8)
    width: float = Field(1.8, gt=0, le=3)
    mass: float = Field(1800, ge=500, le=4000)
    capacity_wh: float = Field(60000, gt=0, le=200000)
    charge_pct: float = Field(80, ge=0, le=100)
    max_accel: float = Field(2.5, gt=0, le=6)
    normal_decel: float = Field(3, gt=0, le=6)
    emergency_decel: float = Field(6, gt=0, le=10)
    max_speed: float = Field(130/3.6, gt=0, le=55)

class Fault(BaseModel):
    id: str = ''
    module: Literal['navigation','controller','powertrain','brake','lane','sensor','bms']
    kind: Literal['delay','drop','duplicate','freeze','substitute','stop','withdraw']
    at: float = Field(0, ge=0, le=900)
    duration: float = Field(5, gt=0, le=900)
    message_id: int | None = None
    signal: str | None = None
    value: float | None = None
    delay_ms: float = Field(300, ge=0, le=5000)

    @model_validator(mode='after')
    def valid(self):
        if self.kind == 'withdraw' and self.module != 'navigation':
            raise ValueError('Only navigation offers a SOME/IP service')
        if self.kind in ('freeze','substitute') and self.module not in ('sensor','bms'):
            raise ValueError('Signal faults require sensor or bms')
        if self.kind in ('freeze','substitute') and not self.signal:
            raise ValueError('Select a signal')
        if self.kind == 'substitute' and self.value is None:
            raise ValueError('A substitute value is required')
        mids={'sensor':256,'bms':272,'controller':512,'powertrain':528,'brake':544,'lane':560,'navigation':32769}
        if self.message_id is not None and self.message_id!=mids[self.module]:
            raise ValueError('Message identifier is not published by this module')
        if self.kind in ('freeze','substitute'):
            from .sdk import DB
            signals={s.name:s for s in DB.get_message_by_frame_id(mids[self.module]).signals}
            if self.signal not in signals or self.signal=='Sequence':raise ValueError('Unknown or unsupported fault signal')
            signal=signals[self.signal]
            if self.value is not None and not (signal.minimum<=self.value<=signal.maximum):raise ValueError('Substitute value is outside the signal range')
        return self

class Assertion(BaseModel):
    kind: Literal['arrived','max_speed','min_charge','stopped','no_recorder_loss']
    value: float = 0

class RunRequest(BaseModel):
    route_id: str = 'carla-city'
    vehicle: Vehicle = Field(default_factory=Vehicle)
    seed: int = 42
    modules: dict[str,dict] = Field(default_factory=dict)
    duration: float = Field(900, gt=0, le=900)
    faults: list[Fault] = Field(default_factory=list)
    assertions: list[Assertion] = Field(default_factory=lambda:[Assertion(kind='arrived'),Assertion(kind='no_recorder_loss')])

    @model_validator(mode='after')
    def module_roles(self):
        if set(self.modules)-set(ROLES):raise ValueError('Module configuration contains an unknown role')
        return self

class ModuleManifest(BaseModel):
    schema_version: Literal['1.0']='1.0'
    identity: str
    image: str
    role: Literal['navigation','controller','powertrain','brake','lane','sensor','bms']
    endpoint: str
    health_endpoint: str='/health'
    application_command: str='python3 -m sdv.application'
    publishes: list[str]
    consumes: list[str]
    configuration: dict = Field(default_factory=dict)
