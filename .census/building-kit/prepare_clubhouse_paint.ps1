$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$paintRoot = Join-Path $PSScriptRoot 'clubhouse-paint'
New-Item -ItemType Directory -Force -Path $paintRoot | Out-Null
$fontFamily = 'Arial Rounded MT Bold'
$board = [System.Drawing.Color]::FromArgb(236,221,188)
$grain = [System.Drawing.Color]::FromArgb(206,186,146)
$navy = [System.Drawing.Color]::FromArgb(30,72,112)
$dolphinBlue = [System.Drawing.Color]::FromArgb(44,110,170)
$shrimpCoral = [System.Drawing.Color]::FromArgb(226,92,62)
$outline = [System.Drawing.Color]::FromArgb(250,244,228)
$warnRed = [System.Drawing.Color]::FromArgb(200,52,40)

function New-Board($width,$height,$planks) {
    $bitmap = [System.Drawing.Bitmap]::new($width,$height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $graphics.Clear($board)
    $seam = [System.Drawing.Pen]::new($grain,5)
    for ($i = 1; $i -lt $planks; $i++) {
        $y = [int]($height * $i / $planks)
        $graphics.DrawLine($seam,0,$y,$width,$y)
    }
    $seam.Dispose()
    return @($bitmap,$graphics)
}

# Draws one line centred, shrunk to fit, with a pale outline so it reads on wood.
function Draw-Line($graphics,$text,$size,$centerY,$width,$color,$stroke) {
    $family = [System.Drawing.FontFamily]::new($fontFamily)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap -bor [System.Drawing.StringFormatFlags]::NoClip
    $format.Trimming = [System.Drawing.StringTrimming]::None
    while ($true) {
        $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
        $path.AddString($text,$family,0,$size,[System.Drawing.RectangleF]::new(0,$centerY-$size,$width,$size*2),$format)
        if ($path.GetBounds().Width -le $width*.90) { break }
        $path.Dispose(); $size *= .95
    }
    $pen = [System.Drawing.Pen]::new($outline,$stroke)
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.DrawPath($pen,$path)
    $brush = [System.Drawing.SolidBrush]::new($color)
    $graphics.FillPath($brush,$path)
    $brush.Dispose(); $pen.Dispose(); $path.Dispose(); $format.Dispose(); $family.Dispose()
}

function Save-Board($bitmap,$graphics,$name) {
    $graphics.Dispose()
    $bitmap.Save((Join-Path $paintRoot ($name+'.png')),[System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

$main = New-Board 1600 900 5
Draw-Line $main[1] 'FLIPPER &' 250 190 1600 $dolphinBlue 26
Draw-Line $main[1] "SHRIMP'S" 250 450 1600 $shrimpCoral 26
Draw-Line $main[1] 'PLACE' 190 710 1600 $dolphinBlue 22
Save-Board $main[0] $main[1] 'main'

$fishing = New-Board 900 640 4
Draw-Line $fishing[1] 'NO' 150 110 900 $navy 14
Draw-Line $fishing[1] 'FISHING' 150 270 900 $navy 14
$red = [System.Drawing.Pen]::new($warnRed,26)
$fishBrush = [System.Drawing.SolidBrush]::new($navy)
$fishing[1].FillEllipse($fishBrush,370,472,140,66)
$fishing[1].FillPolygon($fishBrush,[System.Drawing.Point[]]@([System.Drawing.Point]::new(500,505),[System.Drawing.Point]::new(545,470),[System.Drawing.Point]::new(545,540)))
$fishing[1].DrawEllipse($red,340,395,220,220)
$fishing[1].DrawLine($red,378,433,522,577)
$red.Dispose(); $fishBrush.Dispose()
Save-Board $fishing[0] $fishing[1] 'no-fishing'

$wigglers = New-Board 900 640 4
Draw-Line $wigglers[1] 'WATER' 150 125 900 $navy 14
Draw-Line $wigglers[1] 'WIGGLERS' 150 320 900 $navy 14
Draw-Line $wigglers[1] 'WELCOME.' 150 515 900 $navy 14
Save-Board $wigglers[0] $wigglers[1] 'wigglers'
