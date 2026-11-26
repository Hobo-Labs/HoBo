# Animation

Sprite sheet animation using quads and frame timing.

## Concept

Animation = cycling through images (frames) over time.

Two approaches:
1. **Multiple images**: Load separate files for each frame
2. **Sprite sheets**: One image containing all frames, use quads to draw portions

**Sprite sheets are preferred** for performance and organization.

## Basic Frame Animation

### Using Separate Images

```lua
function love.load()
    frames = {}
    for i = 1, 5 do
        frames[i] = love.graphics.newImage("walk" .. i .. ".png")
    end

    currentFrame = 1
    frameTime = 0
    frameDuration = 0.1  -- 10 FPS animation
end

function love.update(dt)
    frameTime = frameTime + dt

    if frameTime >= frameDuration then
        frameTime = frameTime - frameDuration
        currentFrame = currentFrame + 1
        if currentFrame > #frames then
            currentFrame = 1
        end
    end
end

function love.draw()
    love.graphics.draw(frames[currentFrame], 100, 100)
end
```

## Quads (Sprite Sheets)

A quad defines a rectangular region of an image.

### Creating Quads

```lua
love.graphics.newQuad(x, y, width, height, imageWidth, imageHeight)
```

- `x, y`: Top-left corner of the region
- `width, height`: Size of the region
- `imageWidth, imageHeight`: Full image dimensions

### Example: 4-Frame Animation

Given a sprite sheet with frames arranged horizontally:
```
[Frame1][Frame2][Frame3][Frame4]
  0-32   32-64   64-96   96-128
```

```lua
function love.load()
    spriteSheet = love.graphics.newImage("walk.png")

    local frameW = 32
    local frameH = 32
    local imgW = spriteSheet:getWidth()
    local imgH = spriteSheet:getHeight()

    frames = {}
    for i = 0, 3 do
        frames[i + 1] = love.graphics.newQuad(
            i * frameW, 0,           -- Position in sheet
            frameW, frameH,          -- Frame size
            imgW, imgH               -- Image dimensions
        )
    end

    currentFrame = 1
    frameTime = 0
end

function love.update(dt)
    frameTime = frameTime + dt
    if frameTime >= 0.1 then
        frameTime = 0
        currentFrame = currentFrame % #frames + 1
    end
end

function love.draw()
    love.graphics.draw(spriteSheet, frames[currentFrame], 100, 100)
end
```

## Multi-Row Sprite Sheets

For sheets with multiple rows:

```lua
function loadFrames(image, frameW, frameH, numFrames)
    local frames = {}
    local imgW = image:getWidth()
    local imgH = image:getHeight()
    local cols = math.floor(imgW / frameW)

    for i = 0, numFrames - 1 do
        local col = i % cols
        local row = math.floor(i / cols)

        frames[i + 1] = love.graphics.newQuad(
            col * frameW, row * frameH,
            frameW, frameH,
            imgW, imgH
        )
    end

    return frames
end

function love.load()
    sheet = love.graphics.newImage("character.png")
    walkFrames = loadFrames(sheet, 64, 64, 8)
end
```

## Animation Class

A reusable animation system:

```lua
local Animation = {}
Animation.__index = Animation

function Animation:new(image, frameWidth, frameHeight, frameDuration, frameCount)
    local anim = setmetatable({}, Animation)

    anim.image = image
    anim.frameWidth = frameWidth
    anim.frameHeight = frameHeight
    anim.frameDuration = frameDuration or 0.1

    -- Generate quads
    anim.frames = {}
    local imgW, imgH = image:getDimensions()
    local cols = math.floor(imgW / frameWidth)

    for i = 0, (frameCount or cols) - 1 do
        local col = i % cols
        local row = math.floor(i / cols)
        anim.frames[i + 1] = love.graphics.newQuad(
            col * frameWidth, row * frameHeight,
            frameWidth, frameHeight,
            imgW, imgH
        )
    end

    anim.currentFrame = 1
    anim.timer = 0
    anim.playing = true
    anim.looping = true

    return anim
end

function Animation:update(dt)
    if not self.playing then return end

    self.timer = self.timer + dt

    if self.timer >= self.frameDuration then
        self.timer = self.timer - self.frameDuration
        self.currentFrame = self.currentFrame + 1

        if self.currentFrame > #self.frames then
            if self.looping then
                self.currentFrame = 1
            else
                self.currentFrame = #self.frames
                self.playing = false
            end
        end
    end
end

function Animation:draw(x, y, r, sx, sy, ox, oy)
    love.graphics.draw(
        self.image,
        self.frames[self.currentFrame],
        x, y, r or 0, sx or 1, sy or 1,
        ox or 0, oy or 0
    )
end

function Animation:reset()
    self.currentFrame = 1
    self.timer = 0
    self.playing = true
end

function Animation:stop()
    self.playing = false
end

function Animation:play()
    self.playing = true
end

function Animation:setFrame(frame)
    self.currentFrame = math.max(1, math.min(frame, #self.frames))
end

return Animation
```

### Using the Animation Class

```lua
local Animation = require("animation")

function love.load()
    local sheet = love.graphics.newImage("player.png")

    walkAnim = Animation:new(sheet, 32, 32, 0.1, 4)
    walkAnim.looping = true

    jumpAnim = Animation:new(sheet, 32, 32, 0.15, 3)
    jumpAnim.looping = false
end

function love.update(dt)
    walkAnim:update(dt)
end

function love.draw()
    walkAnim:draw(100, 100)
end
```

## Multiple Animations per Entity

```lua
local Player = {}
Player.__index = Player

function Player:new(x, y, sheet)
    local p = setmetatable({}, Player)

    p.x = x
    p.y = y
    p.direction = 1  -- 1 = right, -1 = left

    -- Define animation regions (assuming organized sprite sheet)
    p.animations = {
        idle = Animation:new(sheet, 32, 32, 0.2, 2),
        walk = Animation:new(sheet, 32, 32, 0.1, 4),
        jump = Animation:new(sheet, 32, 32, 0.15, 3),
    }

    p.currentAnim = "idle"

    return p
end

function Player:setAnimation(name)
    if self.currentAnim ~= name then
        self.currentAnim = name
        self.animations[name]:reset()
    end
end

function Player:update(dt)
    -- State logic determines animation
    if self.jumping then
        self:setAnimation("jump")
    elseif math.abs(self.vx) > 0 then
        self:setAnimation("walk")
    else
        self:setAnimation("idle")
    end

    self.animations[self.currentAnim]:update(dt)
end

function Player:draw()
    local anim = self.animations[self.currentAnim]
    anim:draw(self.x, self.y, 0, self.direction, 1, 16, 16)
end
```

## Bleeding Fix

When scaling or rotating sprites, adjacent pixels in the sheet can "bleed" into view.

**Solution**: Add 1-pixel transparent border around each frame.

```
Before: [Frame1][Frame2][Frame3]
After:  [.Frame1.][.Frame2.][.Frame3.]
        (. = transparent pixel)
```

Adjust quad positions to skip the border:

```lua
local border = 1
local frameW = 32
local frameH = 32
local paddedW = frameW + border * 2
local paddedH = frameH + border * 2

for i = 0, numFrames - 1 do
    quads[i + 1] = love.graphics.newQuad(
        border + i * paddedW,
        border,
        frameW, frameH,
        imgW, imgH
    )
end
```

## Animation Speed Control

```lua
-- Slow down animation
anim.frameDuration = 0.2  -- Half speed

-- Speed up animation
anim.frameDuration = 0.05  -- Double speed

-- Variable speed based on game state
function Player:update(dt)
    if self.running then
        self.walkAnim.frameDuration = 0.05
    else
        self.walkAnim.frameDuration = 0.1
    end
end
```

## Animation Events

Trigger actions on specific frames:

```lua
function Animation:update(dt)
    local previousFrame = self.currentFrame
    -- ... normal update logic ...

    if self.currentFrame ~= previousFrame then
        if self.onFrameChange then
            self.onFrameChange(self.currentFrame)
        end
    end
end

-- Usage
attackAnim.onFrameChange = function(frame)
    if frame == 3 then
        dealDamage()
    end
end
```
