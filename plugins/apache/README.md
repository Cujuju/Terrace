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

The server chooses the settlement, direction and terrain clearance. A player
receives a flight only after revealing attempted targets and terrain chunks consulted
by that plan, including rejected approaches, and the aircraft's current position.
Unrelated settlements add no visibility requirements. Locked terrain adds
no clearance requirement and is never read. The renderer hides the aircraft over
unrevealed ground; newly revealed terrain uses the existing climb and clearance guard.
The full curve is evaluated on every rendered frame. Its position, velocity and
acceleration remain continuous through the pass; clock corrections change speed
gradually rather than snapping to network positions. Bank follows lateral
acceleration; pitch follows climb and acceleration. Rotors preserve the authored
pivot orientations. This is an authored flight animation, not a helicopter physics
simulation.

The corridor includes the aircraft's full rotational envelope, both rotor sweeps,
and three world units for the current settlement models (the largest watchtower
is below 2.8). Asset preload rejects aircraft outside that envelope. A taller
settlement model requires updating this documented height agreement.
Steep approaches are rejected and another bearing is tried. The client checks
the same swept corridor ahead and adds a smooth climb after terrain changes.
If an immediate edit intersects its current envelope, the aircraft stays undrawn
until the climb clears it.

Rendering uses the 256px KTX2 asset at the shared real-size scale: 1,050 triangles
merged into one rigidly skinned surface, one draw call, one material, no new lights. The rig and
material are built at attach, warmed while hidden, and reused for every visit.
The 2048px asset remains available for authoring and inspection, and is not loaded
by this plugin. Entry, departure and visibility arrivals use short dithered fades.
Reduced-motion preference stops decorative rotor animation. Cleanup releases the
rig, assets, subscriptions and preference listener.
