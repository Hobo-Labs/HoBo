# Graphics & Drawing

Images, shapes, colors, transforms, and screen adaptation.

## Loading Images

```lua
function love.load()
    -- Load from project directory
    playerImage = love.graphics.newImage("player.png")

    -- Load from subdirectory
    tilesheet = love.graphics.newImage("assets/tiles.png")
end
```

**Supported formats**: PNG (recommended), JPEG, GIF, BMP, TGA

**PNG is preferred** because it's lossless and supports transparency.

## Drawing Images

### Basic Drawing

```lua
love.graphics.draw(image, x, y)
```

### Full Signature

```lua
love.graphics.draw(
    image,    -- Image to draw
    x, y,     -- Position
    r,        -- Rotation (radians)
    sx, sy,   -- Scale (1 = normal, 2 = double, -1 = flip)
    ox, oy,   -- Origin offset (rotation/scale pivot)
    kx, ky    -- Shear
)
```

### Examples

```lua
-- Draw at position
love.graphics.draw(img, 100, 50)

-- Draw rotated 45 degrees
love.graphics.draw(img, 100, 50, math.rad(45))

-- Draw scaled 2x
love.graphics.draw(img, 100, 50, 0, 2, 2)

-- Draw flipped horizontally
love.graphics.draw(img, 100, 50, 0, -1, 1)

-- Draw centered and rotated (origin at center)
local w, h = img:getDimensions()
love.graphics.draw(img, 100, 50, math.rad(45), 1, 1, w/2, h/2)
```

## Image Properties

```lua
local width = image:getWidth()
local height = image:getHeight()
local w, h = image:getDimensions()
```

## Colors

Colors use values from 0 to 1 (not 0 to 255).

```lua
-- Set drawing color (RGBA)
love.graphics.setColor(1, 0, 0, 1)      -- Red, fully opaque
love.graphics.setColor(0, 0.5, 1, 0.5)  -- Blue, 50% transparent

-- Reset to white (required before drawing images normally)
love.graphics.setColor(1, 1, 1, 1)

-- Background color (set once)
love.graphics.setBackgroundColor(0.1, 0.1, 0.2)
```

**Converting from 0-255**:
```lua
local r, g, b = 255, 128, 64
love.graphics.setColor(r/255, g/255, b/255)
```

## Drawing Shapes

### Rectangles

```lua
-- Filled rectangle
love.graphics.rectangle("fill", x, y, width, height)

-- Outline rectangle
love.graphics.rectangle("line", x, y, width, height)

-- Rounded corners
love.graphics.rectangle("fill", x, y, w, h, rx, ry)
```

### Circles

```lua
-- Filled circle
love.graphics.circle("fill", x, y, radius)

-- Circle outline
love.graphics.circle("line", x, y, radius)

-- Segments (smoothness, default 36)
love.graphics.circle("fill", x, y, radius, 64)
```

### Ellipses

```lua
love.graphics.ellipse("fill", x, y, radiusX, radiusY)
```

### Lines

```lua
love.graphics.line(x1, y1, x2, y2)
love.graphics.line(x1, y1, x2, y2, x3, y3, ...)  -- Multiple points
```

### Polygons

```lua
-- Vertices as separate arguments
love.graphics.polygon("fill", x1, y1, x2, y2, x3, y3, ...)

-- Vertices as table
local vertices = {100, 100, 200, 100, 150, 200}
love.graphics.polygon("fill", vertices)
```

## Text

```lua
-- Basic text
love.graphics.print("Hello World", x, y)

-- With rotation/scale
love.graphics.print("Rotated", x, y, rotation, scaleX, scaleY)

-- Formatted text (wrapping)
love.graphics.printf("Long text here", x, y, limit, align)
-- align: "left", "center", "right", "justify"
```

### Custom Fonts

```lua
function love.load()
    -- Load font
    myFont = love.graphics.newFont("font.ttf", 24)
end

function love.draw()
    love.graphics.setFont(myFont)
    love.graphics.print("Custom font", 10, 10)
end
```

## Transforms

### Basic Transforms

```lua
function love.draw()
    love.graphics.push()  -- Save current state

    love.graphics.translate(100, 100)  -- Move origin
    love.graphics.rotate(math.rad(45)) -- Rotate
    love.graphics.scale(2, 2)          -- Scale

    -- Draw at transformed position
    love.graphics.rectangle("fill", 0, 0, 50, 50)

    love.graphics.pop()  -- Restore state
end
```

### Camera Pattern

```lua
local camera = {x = 0, y = 0, scale = 1, rotation = 0}

function love.draw()
    love.graphics.push()

    -- Apply camera transform
    love.graphics.translate(screenW/2, screenH/2)
    love.graphics.rotate(camera.rotation)
    love.graphics.scale(camera.scale)
    love.graphics.translate(-camera.x, -camera.y)

    -- Draw world
    drawWorld()

    love.graphics.pop()

    -- Draw UI (unaffected by camera)
    drawUI()
end
```

## Screen Adaptation

### Get Screen Dimensions

```lua
local w, h = love.graphics.getDimensions()
```

### Handle Resize

```lua
local screenW, screenH

function love.load()
    screenW, screenH = love.graphics.getDimensions()
end

function love.resize(w, h)
    screenW, screenH = w, h
    recalculateLayout()
end
```

### Positioning Strategies

**Percentage-based**:
```lua
local buttonX = screenW * 0.5   -- Center horizontally
local buttonY = screenH * 0.9   -- Near bottom
```

**Anchor-based**:
```lua
local margin = 20
local rightEdge = screenW - margin
local bottomEdge = screenH - margin
```

**Letterboxing** (maintain aspect ratio):
```lua
local gameWidth, gameHeight = 800, 600
local scaleX = screenW / gameWidth
local scaleY = screenH / gameHeight
local scale = math.min(scaleX, scaleY)

local offsetX = (screenW - gameWidth * scale) / 2
local offsetY = (screenH - gameHeight * scale) / 2

function love.draw()
    love.graphics.push()
    love.graphics.translate(offsetX, offsetY)
    love.graphics.scale(scale)

    -- Draw game at 800x600 virtual resolution
    drawGame()

    love.graphics.pop()
end
```

## Line Width and Style

```lua
love.graphics.setLineWidth(3)
love.graphics.setLineStyle("smooth")  -- or "rough"
love.graphics.setLineJoin("miter")    -- "miter", "bevel", "none"
```

## Blend Modes

```lua
love.graphics.setBlendMode("alpha")    -- Default
love.graphics.setBlendMode("add")      -- Additive (glow effects)
love.graphics.setBlendMode("multiply") -- Multiply
love.graphics.setBlendMode("replace")  -- No blending
```

## Canvases (Render Targets)

Draw to an off-screen buffer:

```lua
function love.load()
    canvas = love.graphics.newCanvas(800, 600)
end

function love.draw()
    -- Draw to canvas
    love.graphics.setCanvas(canvas)
    love.graphics.clear()
    drawScene()
    love.graphics.setCanvas()  -- Back to screen

    -- Draw canvas to screen (can apply effects)
    love.graphics.draw(canvas)
end
```

## Stencils

Mask drawing to specific areas:

```lua
function love.draw()
    -- Define stencil shape
    love.graphics.stencil(function()
        love.graphics.circle("fill", 400, 300, 100)
    end, "replace", 1)

    -- Only draw where stencil value is 1
    love.graphics.setStencilTest("greater", 0)
    drawScene()
    love.graphics.setStencilTest()
end
```
