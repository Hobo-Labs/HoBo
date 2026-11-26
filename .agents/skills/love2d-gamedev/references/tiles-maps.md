# Tiles & Maps

Building tile-based levels with tilesets and map data.

## Concept

Tile-based games use a grid of small images (tiles) to create levels.

Benefits:
- **Memory efficient**: Reuse tile images
- **Easy to edit**: Change map data, not individual sprites
- **Collision-friendly**: Grid-based collision is simple

## Tilesets

A tileset is one image containing all tile types:

```
[Grass][Dirt][Stone][Water]
[Tree ][Bush][Rock ][Sand ]
```

### Loading a Tileset

```lua
function love.load()
    tileset = love.graphics.newImage("tileset.png")

    tileW, tileH = 32, 32  -- Each tile is 32x32
    local imgW, imgH = tileset:getDimensions()
    local cols = imgW / tileW
    local rows = imgH / tileH

    -- Create quads for each tile
    tiles = {}
    for row = 0, rows - 1 do
        for col = 0, cols - 1 do
            local id = row * cols + col + 1
            tiles[id] = love.graphics.newQuad(
                col * tileW, row * tileH,
                tileW, tileH,
                imgW, imgH
            )
        end
    end
end
```

**Image dimensions**: Use power-of-two sizes (64, 128, 256, 512) for best compatibility.

## Map Data

Store level layout as a 2D array of tile IDs:

```lua
local map = {
    {1, 1, 1, 1, 1, 1, 1, 1},
    {1, 0, 0, 0, 0, 0, 0, 1},
    {1, 0, 0, 2, 2, 0, 0, 1},
    {1, 0, 0, 0, 0, 0, 0, 1},
    {1, 1, 1, 1, 1, 1, 1, 1},
}
-- 0 = empty, 1 = wall, 2 = floor
```

## Drawing the Map

```lua
function drawMap()
    for row = 1, #map do
        for col = 1, #map[row] do
            local tileId = map[row][col]

            if tileId > 0 then
                local x = (col - 1) * tileW
                local y = (row - 1) * tileH
                love.graphics.draw(tileset, tiles[tileId], x, y)
            end
        end
    end
end
```

## Loading Maps from Files

### Simple Format

```
-- level1.txt
1 1 1 1 1
1 0 0 0 1
1 0 2 0 1
1 0 0 0 1
1 1 1 1 1
```

```lua
function loadMap(filename)
    local map = {}
    local content = love.filesystem.read(filename)

    for line in content:gmatch("[^\n]+") do
        local row = {}
        for tile in line:gmatch("%d+") do
            table.insert(row, tonumber(tile))
        end
        table.insert(map, row)
    end

    return map
end
```

### String-Based Maps

More readable for simple games:

```lua
local mapString = [[
########
#......#
#..##..#
#......#
########
]]

function parseMap(str)
    local map = {}
    local charToTile = {
        ["#"] = 1,  -- Wall
        ["."] = 0,  -- Empty
        ["@"] = 2,  -- Player spawn
        ["$"] = 3,  -- Collectible
    }

    for line in str:gmatch("[^\n]+") do
        local row = {}
        for char in line:gmatch(".") do
            table.insert(row, charToTile[char] or 0)
        end
        if #row > 0 then
            table.insert(map, row)
        end
    end

    return map
end
```

## Tile Collision

### Grid-Based Collision

```lua
function isSolid(tileId)
    return tileId == 1  -- Wall tiles are solid
end

function getTileAt(x, y)
    local col = math.floor(x / tileW) + 1
    local row = math.floor(y / tileH) + 1

    if row >= 1 and row <= #map and col >= 1 and col <= #map[row] then
        return map[row][col]
    end

    return 1  -- Out of bounds = solid
end

function canMoveTo(x, y, width, height)
    -- Check all four corners
    local corners = {
        {x, y},                      -- Top-left
        {x + width - 1, y},          -- Top-right
        {x, y + height - 1},         -- Bottom-left
        {x + width - 1, y + height - 1}  -- Bottom-right
    }

    for _, corner in ipairs(corners) do
        if isSolid(getTileAt(corner[1], corner[2])) then
            return false
        end
    end

    return true
end
```

### Player Movement with Collision

```lua
function Player:update(dt)
    local newX = self.x
    local newY = self.y

    if love.keyboard.isDown("left") then
        newX = newX - self.speed * dt
    end
    if love.keyboard.isDown("right") then
        newX = newX + self.speed * dt
    end
    if love.keyboard.isDown("up") then
        newY = newY - self.speed * dt
    end
    if love.keyboard.isDown("down") then
        newY = newY + self.speed * dt
    end

    -- Check X movement
    if canMoveTo(newX, self.y, self.w, self.h) then
        self.x = newX
    end

    -- Check Y movement
    if canMoveTo(self.x, newY, self.w, self.h) then
        self.y = newY
    end
end
```

## Camera Scrolling

For maps larger than the screen:

```lua
local camera = {x = 0, y = 0}
local mapW = #map[1] * tileW
local mapH = #map * tileH

function updateCamera()
    -- Center camera on player
    camera.x = player.x - screenW / 2
    camera.y = player.y - screenH / 2

    -- Clamp to map bounds
    camera.x = math.max(0, math.min(camera.x, mapW - screenW))
    camera.y = math.max(0, math.min(camera.y, mapH - screenH))
end

function love.draw()
    love.graphics.push()
    love.graphics.translate(-camera.x, -camera.y)

    -- Only draw visible tiles
    local startCol = math.floor(camera.x / tileW) + 1
    local endCol = math.ceil((camera.x + screenW) / tileW) + 1
    local startRow = math.floor(camera.y / tileH) + 1
    local endRow = math.ceil((camera.y + screenH) / tileH) + 1

    for row = startRow, math.min(endRow, #map) do
        for col = startCol, math.min(endCol, #map[row]) do
            local tileId = map[row][col]
            if tileId > 0 then
                love.graphics.draw(tileset, tiles[tileId],
                    (col - 1) * tileW, (row - 1) * tileH)
            end
        end
    end

    player:draw()

    love.graphics.pop()
end
```

## Multiple Layers

Separate visual layers from collision:

```lua
local layers = {
    background = { ... },  -- Decorative, no collision
    collision = { ... },   -- Solid tiles
    foreground = { ... },  -- Drawn on top of player
}

function love.draw()
    drawLayer(layers.background)
    drawPlayer()
    drawLayer(layers.foreground)
end

function checkCollision(x, y)
    return getTileAt(layers.collision, x, y) > 0
end
```

## Tile Properties

For complex games, store tile metadata:

```lua
local tileProperties = {
    [1] = { solid = true, name = "wall" },
    [2] = { solid = false, name = "floor" },
    [3] = { solid = false, name = "water", slows = true },
    [4] = { solid = true, name = "door", openable = true },
}

function isSolid(tileId)
    local props = tileProperties[tileId]
    return props and props.solid
end
```

## Tiled Map Editor Integration

[Tiled](https://www.mapeditor.org/) is a popular free map editor. Export as JSON or Lua:

```lua
-- Load Tiled Lua export
local mapData = require("level1")

function love.load()
    -- Parse Tiled format
    tileW = mapData.tilewidth
    tileH = mapData.tileheight

    for _, layer in ipairs(mapData.layers) do
        if layer.type == "tilelayer" then
            -- Convert 1D array to 2D
            local map = {}
            local i = 1
            for row = 1, layer.height do
                map[row] = {}
                for col = 1, layer.width do
                    map[row][col] = layer.data[i]
                    i = i + 1
                end
            end
        end
    end
end
```

Or use a library like [STI (Simple Tiled Implementation)](https://github.com/karai17/Simple-Tiled-Implementation).

## Best Practices

1. **Power-of-two tilesets**: 32x32, 64x64, 128x128 tiles work best
2. **Separate collision from visuals**: Not all visible tiles block movement
3. **Cull off-screen tiles**: Only draw what's visible
4. **Use sprite batches**: For many tiles, batch drawing is faster
5. **Design for the grid**: Align objects to tile boundaries when possible

## Sprite Batches

For better performance with many tiles:

```lua
function love.load()
    spriteBatch = love.graphics.newSpriteBatch(tileset, 1000)
    rebuildBatch()
end

function rebuildBatch()
    spriteBatch:clear()

    for row = 1, #map do
        for col = 1, #map[row] do
            local tileId = map[row][col]
            if tileId > 0 then
                spriteBatch:add(tiles[tileId],
                    (col - 1) * tileW,
                    (row - 1) * tileH)
            end
        end
    end
end

function love.draw()
    love.graphics.draw(spriteBatch)
end
```
