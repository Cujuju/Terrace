$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$paintRoot = Join-Path $PSScriptRoot 'cabaret-paint'
New-Item -ItemType Directory -Force -Path $paintRoot | Out-Null
# Retained generated reference artwork is never rerolled during a rebuild.
Copy-Item -LiteralPath (Join-Path $paintRoot 'front-reference.png') -Destination (Join-Path $paintRoot 'front.png') -Force
$gold = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(204,161,88))
$pen = [System.Drawing.Pen]::new($gold,7)
function Paint-Text($graphics,$text,$size,$top,$width) {
    $font = [System.Drawing.Font]::new('Georgia',$size,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
    while ($graphics.MeasureString($text,$font).Width -gt ($width-70)) {
        $font.Dispose(); $size *= .95
        $font = [System.Drawing.Font]::new('Georgia',$size,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
    }
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString($text,$font,$gold,[System.Drawing.RectangleF]::new(0,$top,$width,200),$format)
    $format.Dispose(); $font.Dispose()
}
function Paint-Heart($graphics,$x,$y,$size) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddBezier($x,$y+$size*.9,$x-$size*.85,$y+$size*.25,$x-$size*.45,$y-$size*.5,$x,$y)
    $path.AddBezier($x,$y,$x+$size*.45,$y-$size*.5,$x+$size*.85,$y+$size*.25,$x,$y+$size*.9)
    $graphics.DrawPath($pen,$path)
    $path.Dispose()
}
$panels = @{
    'wing-left' = @('SALOON','GIRLS','','FINE','SPIRITS','','DISCRETION','ALWAYS')
    'wing-right' = @('PLEASURE','COMPANY','AND','A WARM','BED')
    'door-left' = @('BEER','WHISKEY','GIRLS')
    'door-right' = @('MUSIC','GAMBLING','ROOMS')
}
foreach ($name in @('side','awning','flag','wing-left','wing-right','door-left','door-right')) {
    $width = if ($name -eq 'awning') { 1800 } else { 900 }
    $height = if ($name -eq 'awning') { 160 } elseif ($name -eq 'side') { 1400 } else { 1200 }
    $bitmap = [System.Drawing.Bitmap]::new($width,$height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.Color]::FromArgb(92,24,32))
    if ($name -eq 'side') {
        $graphics.DrawRectangle($pen,25,25,850,1350)
        Paint-Text $graphics "DURAND'S" 148 115 $width
        Paint-Heart $graphics 450 480 155
        Paint-Text $graphics 'SALOON' 150 775 $width
        Paint-Text $graphics 'GIRLS' 150 970 $width
        Paint-Text $graphics 'ROOMS' 150 1165 $width
    } elseif ($name -eq 'awning') {
        Paint-Text $graphics 'GOOD DRINKS  -  BETTER COMPANY' 92 12 $width
        $graphics.DrawLine($pen,25,142,1775,142)
    } elseif ($name -eq 'flag') {
        $graphics.DrawRectangle($pen,55,30,790,1115)
        $graphics.DrawRectangle($pen,88,62,724,1050)
        # The front heart is authored in geometry so it survives the low atlas.
    } else {
        $lines = $panels[$name]
        $graphics.DrawRectangle($pen,24,24,852,1152)
        $lineHeight = if ($name -eq 'wing-left') { 126 } elseif ($name -eq 'wing-right') { 205 } else { 250 }
        $size = if ($name -eq 'wing-left') { 100 } elseif ($name -eq 'wing-right') { 136 } else { 151 }
        for ($i=0; $i -lt $lines.Count; $i++) { Paint-Text $graphics $lines[$i] $size (90+$i*$lineHeight) $width }
        if ($name.StartsWith('door-')) { Paint-Heart $graphics 450 940 96 }
    }
    $bitmap.Save((Join-Path $paintRoot ($name+'.png')),[System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
}
$gold.Dispose();$pen.Dispose()
