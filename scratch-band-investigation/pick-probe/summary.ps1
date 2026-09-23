param([string]$Label)
$r = Get-Content (Join-Path $PSScriptRoot "results/$Label.json") -Raw | ConvertFrom-Json
foreach ($x in $r) {
  "== $($x.mesher)/$($x.mode) err=$($x.error) pitBase=$($x.pitSite.base) dig=$($x.pitAfterDig -join ',') rim=$($x.rimAfterDig -join ',') pickInPit=$($x.pickInPit)/$($x.pickTotal) anchorInPit=$($x.anchorInPit) null=$($x.pickNull)"
  $x.stampClicks | ForEach-Object { "  press $($_.press) pick=$($_.pick -join ',') anchor=$($_.anchor -join ',') pit=$($_.pit -join ',') rim=$($_.rim) outside=$($_.outside)" }
  $s = $x.stroke
  "  stroke: frames=$($s.frames) busy=$($s.busyFrames) nullPick=$($s.nullPickFrames) offChunk=$($s.offTargetChunkFrames) anchorsMissing=$($s.anchorsMissing) far=$($s.anchorsFar) repicks=$($s.repicks) maxDist=$($s.maxAnchorDist) pickMs med=$([math]::Round($s.pickMsMedian,2)) p95=$([math]::Round($s.pickMsP95,2))"
  "  busyRuns(frames)=$($x.busyRuns -join ',')"
  if ($x.pickCost) { $x.pickCost.PSObject.Properties | ForEach-Object { "  pick el=$($_.Name): med=$([math]::Round($_.Value.median,3)) p95=$([math]::Round($_.Value.p95,3)) max=$([math]::Round($_.Value.max,3)) ms" } }
}
