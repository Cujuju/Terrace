# Apache visits

One Apache approaches an existing settlement, descends into a low pass, banks
through a broad S-turn, then accelerates and climbs away. A visit lasts 28 seconds.
It does not fire or damage buildings.

Enable **apache** in the world's plugin controls. **Buzz a settlement** targets a
standing structure within 160 cells of the selected location. Automatic arrivals
begin after 20 seconds when there are players and settlements. The `arrivals`
setting selects `occasional` (150–210 seconds between visits), `frequent` (60–120),
or `manual`. With no suitable settlement, selection retries after 15 seconds.
The server discovers the plugin at boot; the client registry includes its view.

The structures sibling is resolved through the host, using a documented copy of
`standingStructures()`. With that sibling disabled, the plugin waits. Flights are
transient visitors and reset on world close/reopen, like saucer encounters.

The server chooses the settlement, direction and terrain clearance. Per-player
visibility gates every broadcast, and the renderer clips to revealed terrain.
The full curve is evaluated on every rendered frame. Its position, velocity and
acceleration remain continuous through the pass; clock corrections change speed
gradually rather than snapping to network positions. Bank follows lateral
acceleration; pitch follows climb and acceleration. Rotors preserve the authored
pivot orientations. This is an authored flight animation, not a helicopter physics
simulation.

The corridor includes rotor clearance and three world units above terrain to clear
the current settlement models. Steep approaches are rejected and another bearing
is tried. The client also looks ahead at drawn terrain and adds a smooth climb if
the ground is sculpted upward during a pass. An instantaneous terrain edit directly
through the aircraft cannot be cleared in advance.

Rendering uses the 256px KTX2 asset at scale 1: 1,050 triangles merged into one
rigidly skinned surface, one draw call, one material, no new lights. The rig and
material are built at attach, warmed while hidden, and reused for every visit.
The 2048px asset remains available for authoring and inspection, and is not loaded
by this plugin. Entry, departure and visibility arrivals use short dithered fades.
Reduced-motion preference stops decorative rotor animation. Cleanup releases the
rig, assets, subscriptions and preference listener.
