# Touch Controls Implementation

Patterns and code for implementing touch controls in Love2D iOS games.

## Touch Event System

Love2D provides three touch callbacks:

```lua
function love.touchpressed(id, x, y, dx, dy, pressure)
    -- Finger touched screen
    -- id: unique identifier for this finger (multitouch support)
    -- x, y: position in screen coordinates
    -- pressure: 0-1 on devices that support it
end

function love.touchmoved(id, x, y, dx, dy, pressure)
    -- Finger moved while touching
    -- dx, dy: delta from last position
end

function love.touchreleased(id, x, y, dx, dy, pressure)
    -- Finger lifted from screen
end
```

**Important**: Track touch IDs for multitouch. Don't assume single touch.

## Virtual Joystick Implementation

### Basic Structure

```lua
local Touch = {}
Touch.__index = Touch

function Touch:new(screenW, screenH)
    local self = setmetatable({}, Touch)

    self.screenW = screenW
    self.screenH = screenH

    -- Joystick state
    self.joystick = {
        active = false,
        touchId = nil,
        baseX = 0,
        baseY = 0,
        knobX = 0,
        knobY = 0,
        radius = 60,
        knobRadius = 25,
        deadzone = 0.15
    }

    -- Output values (-1 to 1)
    self.moveX = 0
    self.moveY = 0

    return self
end
```

### Floating Joystick Pattern

Joystick appears where you touch (more intuitive than fixed position):

```lua
function Touch:touchpressed(id, x, y)
    local js = self.joystick

    -- Left third of screen, bottom half = joystick zone
    if x < self.screenW / 3 and y > self.screenH / 2 then
        js.active = true
        js.touchId = id
        js.baseX = x
        js.baseY = y
        js.knobX = x
        js.knobY = y
    end
end

function Touch:touchmoved(id, x, y)
    local js = self.joystick

    if js.active and js.touchId == id then
        local dx = x - js.baseX
        local dy = y - js.baseY
        local dist = math.sqrt(dx * dx + dy * dy)

        -- Clamp knob to radius
        if dist > js.radius then
            dx = dx / dist * js.radius
            dy = dy / dist * js.radius
            dist = js.radius
        end

        js.knobX = js.baseX + dx
        js.knobY = js.baseY + dy

        -- Normalize to -1 to 1 with deadzone
        local normalizedDist = dist / js.radius
        if normalizedDist < js.deadzone then
            self.moveX = 0
            self.moveY = 0
        else
            -- Remap deadzone to full range
            local scale = (normalizedDist - js.deadzone) / (1 - js.deadzone)
            self.moveX = (dx / dist) * scale
            self.moveY = (dy / dist) * scale
        end
    end
end

function Touch:touchreleased(id)
    local js = self.joystick

    if js.touchId == id then
        js.active = false
        js.touchId = nil
        self.moveX = 0
        self.moveY = 0
    end
end
```

### Drawing the Joystick

```lua
function Touch:draw()
    local js = self.joystick

    if js.active then
        -- Base circle (semi-transparent)
        love.graphics.setColor(1, 1, 1, 0.3)
        love.graphics.circle("fill", js.baseX, js.baseY, js.radius)
        love.graphics.setColor(1, 1, 1, 0.5)
        love.graphics.circle("line", js.baseX, js.baseY, js.radius)

        -- Knob
        love.graphics.setColor(0.2, 0.6, 1, 0.8)
        love.graphics.circle("fill", js.knobX, js.knobY, js.knobRadius)
    end

    love.graphics.setColor(1, 1, 1, 1)  -- Reset color
end
```

## Action Buttons

### Button Structure

```lua
function Touch:new(screenW, screenH)
    -- ... joystick setup ...

    -- Action buttons (right side of screen)
    local btnSize = 70
    local margin = 30

    self.fireButton = {
        x = screenW - margin - btnSize,
        y = screenH - margin - btnSize,
        radius = btnSize / 2,
        active = false,
        touchId = nil,
        label = "FIRE",
        color = {0.8, 0.2, 0.2}
    }

    self.jumpButton = {
        x = screenW - margin - btnSize,
        y = screenH - margin - btnSize * 2 - 20,
        radius = btnSize / 2,
        active = false,
        touchId = nil,
        label = "JUMP",
        color = {0.2, 0.7, 0.3}
    }

    self.shooting = false
    self.jumped = false
end
```

### Button Touch Handling

```lua
local function pointInCircle(px, py, cx, cy, r)
    local dx = px - cx
    local dy = py - cy
    return (dx * dx + dy * dy) <= (r * r)
end

function Touch:touchpressed(id, x, y)
    -- Check fire button
    local fb = self.fireButton
    if pointInCircle(x, y, fb.x, fb.y, fb.radius * 1.2) then
        fb.active = true
        fb.touchId = id
        self.shooting = true
        return
    end

    -- Check jump button
    local jb = self.jumpButton
    if pointInCircle(x, y, jb.x, jb.y, jb.radius * 1.2) then
        jb.active = true
        jb.touchId = id
        self.jumped = true  -- Single press, not held
        return
    end

    -- ... joystick handling ...
end

function Touch:touchreleased(id)
    if self.fireButton.touchId == id then
        self.fireButton.active = false
        self.fireButton.touchId = nil
        self.shooting = false
    end

    if self.jumpButton.touchId == id then
        self.jumpButton.active = false
        self.jumpButton.touchId = nil
    end

    -- ... joystick handling ...
end
```

### Drawing Buttons

```lua
function Touch:drawButton(btn)
    -- Button background
    if btn.active then
        love.graphics.setColor(btn.color[1], btn.color[2], btn.color[3], 0.9)
    else
        love.graphics.setColor(btn.color[1], btn.color[2], btn.color[3], 0.5)
    end
    love.graphics.circle("fill", btn.x, btn.y, btn.radius)

    -- Button border
    love.graphics.setColor(1, 1, 1, 0.7)
    love.graphics.circle("line", btn.x, btn.y, btn.radius)

    -- Label
    love.graphics.setColor(1, 1, 1, 0.9)
    local font = love.graphics.getFont()
    local textW = font:getWidth(btn.label)
    local textH = font:getHeight()
    love.graphics.print(btn.label, btn.x - textW/2, btn.y - textH/2)
end

function Touch:draw()
    self:drawButton(self.fireButton)
    self:drawButton(self.jumpButton)
    -- ... joystick drawing ...
end
```

## Integrating with Game Logic

### In main.lua

```lua
local Touch = require("touch")
local touchControls

function love.load()
    local w, h = love.graphics.getDimensions()

    if love.system.getOS() == "iOS" or love.system.getOS() == "Android" then
        touchControls = Touch:new(w, h)
    end
end

function love.update(dt)
    if touchControls then
        -- Pass touch input to player
        player:setTouchInput(
            touchControls.moveX,
            touchControls.moveY,
            touchControls.shooting,
            touchControls.jumped
        )

        -- Clear single-press flags
        touchControls.jumped = false
    end
end

function love.draw()
    -- Draw game...

    -- Draw touch controls on top
    if touchControls then
        touchControls:draw()
    end
end

function love.touchpressed(id, x, y, dx, dy, pressure)
    if touchControls then
        touchControls:touchpressed(id, x, y)
    end
end

function love.touchmoved(id, x, y, dx, dy, pressure)
    if touchControls then
        touchControls:touchmoved(id, x, y)
    end
end

function love.touchreleased(id, x, y, dx, dy, pressure)
    if touchControls then
        touchControls:touchreleased(id, x, y)
    end
end
```

### In player.lua

```lua
function Player:setTouchInput(moveX, moveY, shooting, jump)
    self.touchMoveX = moveX or 0
    self.touchMoveY = moveY or 0
    self.touchShooting = shooting or false

    if jump then
        self.touchJump = true
    end
end

function Player:update(dt)
    -- Combine keyboard and touch input
    local moveX = 0

    if love.keyboard.isDown("left", "a") then moveX = -1 end
    if love.keyboard.isDown("right", "d") then moveX = 1 end

    -- Touch overrides if active
    if math.abs(self.touchMoveX) > 0.1 then
        moveX = self.touchMoveX
    end

    self.x = self.x + moveX * self.speed * dt

    -- Jumping
    if self.onGround and (love.keyboard.isDown("space", "w", "up") or self.touchJump) then
        self.vy = self.jumpForce
        self.onGround = false
        self.touchJump = false
    end

    -- Shooting
    local shooting = love.mouse.isDown(1) or self.touchShooting
    if shooting then
        self:shoot()
    end
end
```

## Gesture Patterns

### Tap Detection

```lua
local tapState = {
    startTime = 0,
    startX = 0,
    startY = 0,
    maxTapDuration = 0.3,  -- seconds
    maxTapDistance = 20     -- pixels
}

function love.touchpressed(id, x, y)
    tapState.startTime = love.timer.getTime()
    tapState.startX = x
    tapState.startY = y
end

function love.touchreleased(id, x, y)
    local duration = love.timer.getTime() - tapState.startTime
    local dx = x - tapState.startX
    local dy = y - tapState.startY
    local distance = math.sqrt(dx*dx + dy*dy)

    if duration < tapState.maxTapDuration and distance < tapState.maxTapDistance then
        onTap(x, y)  -- Handle tap
    end
end
```

### Swipe Detection

```lua
local swipeState = {
    startX = 0,
    startY = 0,
    minSwipeDistance = 50
}

function love.touchpressed(id, x, y)
    swipeState.startX = x
    swipeState.startY = y
end

function love.touchreleased(id, x, y)
    local dx = x - swipeState.startX
    local dy = y - swipeState.startY
    local distance = math.sqrt(dx*dx + dy*dy)

    if distance > swipeState.minSwipeDistance then
        -- Determine direction
        if math.abs(dx) > math.abs(dy) then
            if dx > 0 then onSwipe("right")
            else onSwipe("left") end
        else
            if dy > 0 then onSwipe("down")
            else onSwipe("up") end
        end
    end
end
```

## Best Practices

1. **Touch target size**: Minimum 44x44 points (Apple HIG recommendation)
2. **Deadzone**: 10-20% to prevent drift from resting thumb
3. **Visual feedback**: Show button press states clearly
4. **Transparency**: Don't obscure gameplay with opaque controls
5. **Thumb reach**: Place controls where thumbs naturally rest
6. **Multitouch**: Always track touch IDs, never assume single touch
