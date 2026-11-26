# Collision Detection

Common collision detection patterns for 2D games.

## AABB (Axis-Aligned Bounding Box)

The simplest and most common collision check. Works for rectangles that don't rotate.

### Basic AABB Check

```lua
function checkCollision(x1, y1, w1, h1, x2, y2, w2, h2)
    return x1 < x2 + w2 and
           x2 < x1 + w1 and
           y1 < y2 + h2 and
           y2 < y1 + h1
end

-- Usage
if checkCollision(player.x, player.y, player.w, player.h,
                  enemy.x, enemy.y, enemy.w, enemy.h) then
    player:takeDamage()
end
```

### Object-Based Version

```lua
function collides(a, b)
    return a.x < b.x + b.w and
           b.x < a.x + a.w and
           a.y < b.y + b.h and
           b.y < a.y + a.h
end

-- Usage
if collides(player, enemy) then
    handleCollision()
end
```

## Circle Collision

Better for round objects, projectiles, or when you want more forgiving hit detection.

```lua
function circleCollision(x1, y1, r1, x2, y2, r2)
    local dx = x2 - x1
    local dy = y2 - y1
    local distance = math.sqrt(dx * dx + dy * dy)
    return distance < r1 + r2
end

-- Usage
if circleCollision(bullet.x, bullet.y, bullet.radius,
                   target.x, target.y, target.radius) then
    target:hit()
end
```

### Distance Without Square Root

For performance-critical code, compare squared distances:

```lua
function circleCollisionFast(x1, y1, r1, x2, y2, r2)
    local dx = x2 - x1
    local dy = y2 - y1
    local distSq = dx * dx + dy * dy
    local radiiSum = r1 + r2
    return distSq < radiiSum * radiiSum
end
```

## Point in Rectangle

Check if a point (like mouse or touch) is inside a rectangle:

```lua
function pointInRect(px, py, rx, ry, rw, rh)
    return px >= rx and px <= rx + rw and
           py >= ry and py <= ry + rh
end

-- Usage (button click)
function love.mousepressed(x, y, button)
    if pointInRect(x, y, button.x, button.y, button.w, button.h) then
        button:click()
    end
end
```

## Point in Circle

```lua
function pointInCircle(px, py, cx, cy, r)
    local dx = px - cx
    local dy = py - cy
    return dx * dx + dy * dy <= r * r
end
```

## Collision Response

Detecting collision is only half the problem. You also need to respond appropriately.

### Stop Movement

```lua
function Player:update(dt)
    local newX = self.x + self.vx * dt
    local newY = self.y + self.vy * dt

    -- Check X movement separately
    if not checkWorldCollision(newX, self.y, self.w, self.h) then
        self.x = newX
    else
        self.vx = 0
    end

    -- Check Y movement separately
    if not checkWorldCollision(self.x, newY, self.w, self.h) then
        self.y = newY
    else
        self.vy = 0
    end
end
```

### Push Out (Minimum Translation Vector)

Calculate how to separate overlapping objects:

```lua
function getMTV(a, b)
    -- Calculate overlap on each axis
    local overlapX = math.min(a.x + a.w, b.x + b.w) - math.max(a.x, b.x)
    local overlapY = math.min(a.y + a.h, b.y + b.h) - math.max(a.y, b.y)

    if overlapX <= 0 or overlapY <= 0 then
        return nil  -- No collision
    end

    -- Push out on shortest axis
    if overlapX < overlapY then
        if a.x < b.x then
            return -overlapX, 0  -- Push left
        else
            return overlapX, 0   -- Push right
        end
    else
        if a.y < b.y then
            return 0, -overlapY  -- Push up
        else
            return 0, overlapY   -- Push down
        end
    end
end

-- Usage
local pushX, pushY = getMTV(player, wall)
if pushX then
    player.x = player.x + pushX
    player.y = player.y + pushY
end
```

## Collision Layers

Not everything collides with everything:

```lua
local LAYER = {
    PLAYER = 1,
    ENEMY = 2,
    PLAYER_BULLET = 4,
    ENEMY_BULLET = 8,
    WALL = 16,
}

-- Define what collides with what
local collisionMatrix = {
    [LAYER.PLAYER] = LAYER.ENEMY + LAYER.ENEMY_BULLET + LAYER.WALL,
    [LAYER.ENEMY] = LAYER.PLAYER_BULLET + LAYER.WALL,
    [LAYER.PLAYER_BULLET] = LAYER.ENEMY + LAYER.WALL,
    [LAYER.ENEMY_BULLET] = LAYER.PLAYER + LAYER.WALL,
}

function shouldCollide(layerA, layerB)
    local mask = collisionMatrix[layerA] or 0
    return bit.band(mask, layerB) > 0
end
```

## Spatial Partitioning

For many objects, checking every pair is slow (O(n²)). Use spatial partitioning.

### Grid-Based Partitioning

```lua
local SpatialGrid = {}
SpatialGrid.__index = SpatialGrid

function SpatialGrid:new(cellSize)
    return setmetatable({
        cellSize = cellSize,
        cells = {}
    }, SpatialGrid)
end

function SpatialGrid:clear()
    self.cells = {}
end

function SpatialGrid:getCellKey(x, y)
    local cx = math.floor(x / self.cellSize)
    local cy = math.floor(y / self.cellSize)
    return cx .. "," .. cy
end

function SpatialGrid:insert(obj)
    -- Insert into all cells the object overlaps
    local x1 = math.floor(obj.x / self.cellSize)
    local y1 = math.floor(obj.y / self.cellSize)
    local x2 = math.floor((obj.x + obj.w) / self.cellSize)
    local y2 = math.floor((obj.y + obj.h) / self.cellSize)

    for cx = x1, x2 do
        for cy = y1, y2 do
            local key = cx .. "," .. cy
            if not self.cells[key] then
                self.cells[key] = {}
            end
            table.insert(self.cells[key], obj)
        end
    end
end

function SpatialGrid:getNearby(obj)
    local nearby = {}
    local seen = {}

    local x1 = math.floor(obj.x / self.cellSize)
    local y1 = math.floor(obj.y / self.cellSize)
    local x2 = math.floor((obj.x + obj.w) / self.cellSize)
    local y2 = math.floor((obj.y + obj.h) / self.cellSize)

    for cx = x1, x2 do
        for cy = y1, y2 do
            local key = cx .. "," .. cy
            if self.cells[key] then
                for _, other in ipairs(self.cells[key]) do
                    if other ~= obj and not seen[other] then
                        seen[other] = true
                        table.insert(nearby, other)
                    end
                end
            end
        end
    end

    return nearby
end
```

### Usage

```lua
local grid = SpatialGrid:new(64)  -- 64px cells

function love.update(dt)
    grid:clear()

    -- Insert all objects
    for _, obj in ipairs(gameObjects) do
        grid:insert(obj)
    end

    -- Check collisions
    for _, obj in ipairs(gameObjects) do
        local nearby = grid:getNearby(obj)
        for _, other in ipairs(nearby) do
            if collides(obj, other) then
                handleCollision(obj, other)
            end
        end
    end
end
```

## Platformer Collision

Special considerations for platformers:

### One-Way Platforms

```lua
function checkPlatformCollision(player, platform)
    -- Only collide when falling down onto the platform
    if player.vy <= 0 then return false end

    -- Only collide when player's feet were above the platform
    local prevBottom = player.prevY + player.h
    local currBottom = player.y + player.h

    if prevBottom <= platform.y and currBottom > platform.y then
        return player.x + player.w > platform.x and
               player.x < platform.x + platform.w
    end

    return false
end
```

### Ground Detection

```lua
function Player:isOnGround()
    -- Check a thin rectangle below the player
    local groundCheckBox = {
        x = self.x + 2,
        y = self.y + self.h,
        w = self.w - 4,
        h = 2
    }

    for _, platform in ipairs(platforms) do
        if collides(groundCheckBox, platform) then
            return true
        end
    end

    return false
end
```

## Continuous Collision Detection

For fast-moving objects that might tunnel through thin walls:

```lua
function sweepAABB(obj, vx, vy, wall)
    -- Calculate time of collision on each axis
    local xEntry, xExit, yEntry, yExit

    if vx > 0 then
        xEntry = (wall.x - (obj.x + obj.w)) / vx
        xExit = (wall.x + wall.w - obj.x) / vx
    elseif vx < 0 then
        xEntry = (wall.x + wall.w - obj.x) / vx
        xExit = (wall.x - (obj.x + obj.w)) / vx
    else
        xEntry = -math.huge
        xExit = math.huge
    end

    -- Similar for Y axis...

    local entryTime = math.max(xEntry, yEntry)
    local exitTime = math.min(xExit, yExit)

    if entryTime > exitTime or entryTime < 0 or entryTime > 1 then
        return nil  -- No collision this frame
    end

    return entryTime  -- Time of collision (0-1)
end
```

## Best Practices

1. **Separate detection from response**: Check collision first, then decide what to do
2. **Check axes separately**: For AABB, this allows sliding along walls
3. **Use appropriate shapes**: Circles for round things, boxes for square things
4. **Spatial partitioning**: Required for many objects (>50)
5. **Debug visualization**: Draw collision boxes during development
6. **Margin of error**: Add small tolerances to prevent floating-point issues

### Debug Visualization

```lua
local debugCollision = true

function drawCollisionBoxes()
    if not debugCollision then return end

    love.graphics.setColor(1, 0, 0, 0.3)
    for _, obj in ipairs(gameObjects) do
        love.graphics.rectangle("fill", obj.x, obj.y, obj.w, obj.h)
    end
    love.graphics.setColor(1, 1, 1, 1)
end
```
