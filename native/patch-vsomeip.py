"""Docker compatibility for vSomeIP 3.7.6's route-notification setting.

The upstream readiness condition still waits for a multicast route after
wait_route_netlink_notification is disabled. Honor that configuration option;
Docker's existing default route remains responsible for actual packet routing.
The modified upstream file retains its MPL-2.0 header and license.
"""
from pathlib import Path
path=Path('/tmp/vsomeip/implementation/routing/src/routing_manager_impl.cpp')
text=path.read_text()
old='return if_state_running_ && (!configuration_->is_sd_enabled() || (configuration_->is_sd_enabled() && sd_route_set_));'
new='return if_state_running_ && (!configuration_->is_sd_enabled() || !configuration_->get_sd_wait_route_netlink_notification() || (configuration_->is_sd_enabled() && sd_route_set_));'
if text.count(old)!=1:raise RuntimeError('Pinned upstream readiness condition changed; review patch')
path.write_text(text.replace(old,new))
