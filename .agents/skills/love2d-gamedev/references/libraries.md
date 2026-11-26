# Libraries

Popular community libraries for Love2D game development.

## Physics & Collision

### bump.lua
**Purpose**: Simple AABB collision detection and response
**URL**: https://github.com/kikito/bump.lua

```lua
local bump = require("lib.bump")

local world = bump.newWorld(64)  -- 64px cell size

-- Add objects
world:add(player, player.x, player.y, player.w, player.h)
world:add(wall, wall.x, wall.y, wall.w, wall.h)

-- Move with collision
local actualX, actualY, cols, len = world:move(player, newX, newY)
player.x, player.y = actualX, actualY

-- Handle collisions
for i = 1, len do
    local col = cols[i]
    if col.other.type == "enemy" then
        player:takeDamage()
    end
end
```

### Windfield
**Purpose**: Physics wrapper for Box2D with simpler API
**URL**: https://github.com/a327ex/windfield

```lua
local wf = require("lib.windfield")

local world = wf.newWorld(0, 512)  -- gravity x, y

local player = world:newRectangleCollider(100, 100, 50, 50)
player:setType("dynamic")

local ground = world:newRectangleCollider(0, 550, 800, 50)
ground:setType("static")

function love.update(dt)
    world:update(dt)
end

function love.draw()
    world:draw()
end
```

## Animation

### anim8
**Purpose**: Animation library for sprite sheets
**URL**: https://github.com/kikito/anim8

```lua
local anim8 = require("lib.anim8")

local image = love.graphics.newImage("player.png")
local grid = anim8.newGrid(32, 32, image:getWidth(), image:getHeight())

local walkAnim = anim8.newAnimation(grid('1-4', 1), 0.1)
local jumpAnim = anim8.newAnimation(grid('1-3', 2), 0.15)

function love.update(dt)
    walkAnim:update(dt)
end

function love.draw()
    walkAnim:draw(image, player.x, player.y)
end
```

## Camera

### gamera
**Purpose**: Camera system with bounds, zoom, rotation
**URL**: https://github.com/kikito/gamera

```lua
local gamera = require("lib.gamera")

-- World bounds
local cam = gamera.new(0, 0, 2000, 2000)

function love.update(dt)
    cam:setPosition(player.x, player.y)
end

function love.draw()
    cam:draw(function(l, t, w, h)
        -- Draw world (l,t,w,h = visible area)
        drawMap()
        drawEntities()
    end)

    -- Draw UI outside camera
    drawUI()
end

-- Zoom
cam:setScale(2)

-- Get world coordinates from screen
local worldX, worldY = cam:toWorld(mouseX, mouseY)
```

### STALKER-X
**Purpose**: Camera with smooth follow, screen shake, deadzone
**URL**: https://github.com/a327ex/STALKER-X

```lua
local Camera = require("lib.stalker-x")

local camera = Camera()

function love.update(dt)
    camera:update(dt)
    camera:follow(player.x, player.y)
end

function love.draw()
    camera:attach()
    drawWorld()
    camera:detach()
    drawUI()
end

-- Screen shake
camera:shake(8, 0.5, 60)  -- intensity, duration, frequency
```

## GUI

### SUIT
**Purpose**: Immediate-mode GUI
**URL**: https://github.com/vrld/suit

```lua
local suit = require("lib.suit")

local input = {text = ""}

function love.update(dt)
    suit.layout:reset(100, 100)

    if suit.Button("Click me", suit.layout:row(200, 30)).hit then
        print("Clicked!")
    end

    suit.Input(input, suit.layout:row())

    if suit.Checkbox(checked, "Enable", suit.layout:row()).changed then
        checked = not checked
    end
end

function love.draw()
    suit.draw()
end
```

### Slab
**Purpose**: Immediate-mode GUI inspired by Dear ImGui
**URL**: https://github.com/flamendless/Slab

```lua
local Slab = require("lib.Slab")

function love.load()
    Slab.Initialize()
end

function love.update(dt)
    Slab.Update(dt)

    Slab.BeginWindow("Debug", {Title = "Debug Panel"})
    Slab.Text("FPS: " .. love.timer.getFPS())

    if Slab.Button("Reset") then
        resetGame()
    end

    Slab.EndWindow()
end

function love.draw()
    drawGame()
    Slab.Draw()
end
```

## State Management

### hump.gamestate
**Purpose**: Game state management
**URL**: https://github.com/vrld/hump

```lua
local Gamestate = require("lib.hump.gamestate")

local menu = {}
local game = {}

function menu:enter()
    -- Called when entering state
end

function menu:update(dt)
end

function menu:draw()
    love.graphics.print("Press SPACE to start", 300, 300)
end

function menu:keypressed(key)
    if key == "space" then
        Gamestate.switch(game)
    end
end

function game:enter()
    player = Player:new(100, 100)
end

function game:update(dt)
    player:update(dt)
end

function game:draw()
    player:draw()
end

function love.load()
    Gamestate.registerEvents()
    Gamestate.switch(menu)
end
```

## Tiled Map Support

### STI (Simple Tiled Implementation)
**Purpose**: Load and render Tiled maps
**URL**: https://github.com/karai17/Simple-Tiled-Implementation

```lua
local sti = require("lib.sti")

local map = sti("maps/level1.lua")

function love.update(dt)
    map:update(dt)
end

function love.draw()
    map:draw()

    -- Draw specific layer
    map:drawLayer(map.layers["foreground"])
end

-- Collision with bump
local sti = require("lib.sti")
local bump = require("lib.bump")

local map = sti("maps/level1.lua", {"bump"})
local world = bump.newWorld()
map:bump_init(world)
```

## Input

### baton
**Purpose**: Input library with controller support
**URL**: https://github.com/tesselode/baton

```lua
local baton = require("lib.baton")

local input = baton.new({
    controls = {
        left = {"key:left", "key:a", "axis:leftx-"},
        right = {"key:right", "key:d", "axis:leftx+"},
        jump = {"key:space", "button:a"},
        shoot = {"key:x", "button:b", "mouse:1"},
    },
    pairs = {
        move = {"left", "right", "up", "down"}
    },
    joystick = love.joystick.getJoysticks()[1]
})

function love.update(dt)
    input:update()

    local moveX, moveY = input:get("move")
    player.x = player.x + moveX * player.speed * dt

    if input:pressed("jump") then
        player:jump()
    end

    if input:down("shoot") then
        player:shoot()
    end
end
```

## Tweening

### flux
**Purpose**: Tweening library
**URL**: https://github.com/rxi/flux

```lua
local flux = require("lib.flux")

-- Tween object properties
flux.to(player, 1, {x = 400, y = 300})
    :ease("quadout")
    :oncomplete(function() print("Done!") end)

-- Chain tweens
flux.to(obj, 0.5, {alpha = 0})
    :after(obj, 0.5, {alpha = 1})

function love.update(dt)
    flux.update(dt)
end
```

### tween.lua
**Purpose**: Simple tweening
**URL**: https://github.com/kikito/tween.lua

```lua
local tween = require("lib.tween")

local target = {x = 100, y = 100}
local myTween = tween.new(2, target, {x = 400, y = 300}, "outQuad")

function love.update(dt)
    local complete = myTween:update(dt)
    if complete then
        -- Tween finished
    end
end
```

## Utilities

### lume
**Purpose**: Collection of utility functions
**URL**: https://github.com/rxi/lume

```lua
local lume = require("lib.lume")

-- Math
lume.clamp(x, min, max)
lume.lerp(a, b, t)
lume.round(x)
lume.sign(x)
lume.distance(x1, y1, x2, y2)
lume.angle(x1, y1, x2, y2)

-- Tables
lume.randomchoice({"a", "b", "c"})
lume.shuffle(t)
lume.filter(t, fn)
lume.map(t, fn)
lume.reduce(t, fn, init)
lume.find(t, value)
lume.merge(t1, t2)

-- Strings
lume.split("a,b,c", ",")
lume.trim("  hello  ")
lume.format("{name} has {n} apples", {name="John", n=5})

-- Serialization
local str = lume.serialize(t)
local t = lume.deserialize(str)
```

### classic
**Purpose**: Tiny class library
**URL**: https://github.com/rxi/classic

```lua
local Object = require("lib.classic")

local Entity = Object:extend()

function Entity:new(x, y)
    self.x = x
    self.y = y
end

function Entity:update(dt) end
function Entity:draw() end

-- Inheritance
local Player = Entity:extend()

function Player:new(x, y)
    Player.super.new(self, x, y)
    self.speed = 200
end

function Player:update(dt)
    -- Player-specific logic
end
```

## Installing Libraries

1. Download the library
2. Place in `lib/` folder
3. Require in your code

```lua
-- For single-file libraries
local bump = require("lib.bump")

-- For folder-based libraries
local sti = require("lib.sti")
```

## Compatibility Notes

- Check library compatibility with your Love2D version
- Some libraries require Love2D 11.x+
- Read the library's README for setup instructions
- Some libraries have additional dependencies
