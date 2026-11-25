"""Sample request paths recorded by the supplied project on 2026-10-13.

On 2026-11-25 the signed-in console marked all ten operations as testable.
The odometer cURL confirmed its exact path. The external request returned
HTTP 403, so the remaining operations were not called during this run.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ApiSpec:
    path: str
    document: str
    kind: str

    @property
    def sample_url(self) -> str:
        return "https://dev.kr-ccapi.hyundai.com/api_sample/v1" + self.path


APIS = {
    "odometer": ApiSpec("/car/status/{car_id}/odometer", "status_odometer", "odometer"),
    "dte": ApiSpec("/car/status/{car_id}/dte", "status_dte", "distance"),
    "engine-oil": ApiSpec(
        "/car/status/warning/{car_id}/engineOil", "statuswarning_engineoil", "warning"
    ),
    "tire-pressure": ApiSpec(
        "/car/status/warning/{car_id}/tirePressure", "statuswarning_tirepressurelamp", "warning"
    ),
    "brake-oil": ApiSpec(
        "/car/status/warning/{car_id}/breakOil", "statuswarning_breakoil", "warning"
    ),
    "low-fuel": ApiSpec(
        "/car/status/warning/{car_id}/lowFuel", "statuswarning_lowfuellight", "warning"
    ),
    "washer-fluid": ApiSpec(
        "/car/status/warning/{car_id}/washerFluid", "statuswarning_washerfluid", "warning"
    ),
    "smart-key-battery": ApiSpec(
        "/car/status/warning/{car_id}/smartKeyBattery", "statuswarning_smartkeybattery", "warning"
    ),
    "ev-battery": ApiSpec("/car/status/{car_id}/ev/battery", "status_evbattery", "battery"),
    "ev-charging": ApiSpec("/car/status/{car_id}/ev/charging", "status_evcharging", "charging"),
}
