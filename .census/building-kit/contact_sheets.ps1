param([string[]]$BuildingIds)
Add-Type -AssemblyName System.Drawing
$censusRoot = Split-Path $PSScriptRoot -Parent
$font = [System.Drawing.Font]::new('Segoe UI',18,[System.Drawing.FontStyle]::Bold)
$smallFont = [System.Drawing.Font]::new('Segoe UI',12)
$brush = [System.Drawing.Brushes]::White
foreach ($id in $BuildingIds) {
    $folder = Join-Path $censusRoot $id
    $shots = if ($id -eq 'durands') { @('45deg','closeup','front') } else { @('45deg','closeup') }
    $sheetHeight = 60 + $shots.Count * 720
    $bitmap = [System.Drawing.Bitmap]::new(1600,$sheetHeight)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::FromArgb(29,33,34))
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    foreach ($column in 0,1) {
        $variantFolder = if ($column -eq 0) { $folder } else { Join-Path $folder 'low' }
        $stats = Get-Content -LiteralPath (Join-Path $variantFolder 'verification.json') -Raw | ConvertFrom-Json
        $label = if ($column -eq 0) { "ORIGINAL | $($stats.triangles) triangles | 2048" } else { "LOW | $($stats.triangles) triangles | 1024" }
        $graphics.DrawString($label,$font,$brush,[float]($column*800+15),[float]12)
        for ($row=0; $row -lt $shots.Count; $row++) {
            $shot = $shots[$row]
            $picture = [System.Drawing.Image]::FromFile((Join-Path $variantFolder "$id-$shot.png"))
            $graphics.DrawImage($picture,[System.Drawing.Rectangle]::new($column*800,55+$row*720,800,720))
            $picture.Dispose()
        }
    }
    $graphics.DrawString("$id | Delivered GLB renders; identical camera and lighting per row",$smallFont,$brush,[float]15,[float]($sheetHeight-20))
    $bitmap.Save((Join-Path $folder 'comparison.png'),[System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose();$bitmap.Dispose()
}
$font.Dispose();$smallFont.Dispose()
