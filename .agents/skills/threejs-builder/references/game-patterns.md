# Three.js Game Patterns

Patterns for building games with Three.js, beyond simple showcase scenes.

---

## Animation State Management

For characters that switch between idle, run, jump, death, etc.

### Finding and Playing Animations

```javascript
// After loading GLTF
const mixer = new THREE.AnimationMixer(model);
const animations = gltf.animations;

// Find animation by name (partial match)
function findAnimation(name) {
    return animations.find(clip =>
        clip.name.toLowerCase().includes(name.toLowerCase())
    );
}

// Play an animation
function playAnimation(name, { loop = true, timeScale = 1 } = {}) {
    const clip = findAnimation(name);
    if (!clip) return null;

    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce);
    action.clampWhenFinished = !loop; // Hold last frame if not looping
    action.timeScale = timeScale;
    action.play();

    return action;
}

// Usage
playAnimation('run');                          // Loop running
playAnimation('jump', { loop: false, timeScale: 2 }); // One-shot, fast
playAnimation('death', { loop: false });       // One-shot, hold last frame
```

### Crossfading Between Animations

```javascript
let currentAction = null;

function switchAnimation(name, { fadeTime = 0.1, ...options } = {}) {
    const clip = findAnimation(name);
    if (!clip) return;

    const newAction = mixer.clipAction(clip);
    newAction.reset();
    newAction.setLoop(options.loop !== false ? THREE.LoopRepeat : THREE.LoopOnce);
    newAction.clampWhenFinished = !options.loop;
    newAction.timeScale = options.timeScale || 1;

    if (currentAction) {
        currentAction.fadeOut(fadeTime);
    }

    newAction.fadeIn(fadeTime).play();
    currentAction = newAction;
}

// Usage in game logic
if (jumping) {
    switchAnimation('jump', { loop: false, timeScale: 2.5 });
} else if (grounded) {
    switchAnimation('run');
}
```

---

## Facing Direction for Side-Scrollers

Flip a character to face left/right:

```javascript
function faceDirection(model, direction) {
    // direction: -1 (left) or 1 (right)
    model.scale.x = Math.abs(model.scale.x) * direction;
}

// Usage
faceDirection(player, velocity.x < 0 ? -1 : 1);
```

---

## Game Loop with State Machine

Organize logic with states:

```javascript
const State = {
    MENU: 'menu',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAME_OVER: 'game_over'
};

let state = State.MENU;

function update(delta) {
    switch (state) {
        case State.MENU:
            // wait for input
            break;
        case State.PLAYING:
            // update player/enemies
            break;
        case State.PAUSED:
            // show overlay
            break;
        case State.GAME_OVER:
            // restart
            break;
    }
}

let lastTime = 0;
renderer.setAnimationLoop((time) => {
    const delta = (time - lastTime) / 1000;
    lastTime = time;
    update(delta);
    renderer.render(scene, camera);
});
```

---

## Time Scaling (Slow Motion)

Scale game time:

```javascript
let timeScale = 1;

function update(delta) {
    const scaledDelta = delta * timeScale;
    mixer.update(scaledDelta);
    // update physics, movement, etc.
}

// Usage
timeScale = 0.2; // slow motion
timeScale = 1.0; // normal
```

---

## Screen Effects

### Camera Shake

```javascript
const shake = {
    time: 0,
    strength: 0.1
};

function triggerShake(duration = 0.2, strength = 0.1) {
    shake.time = duration;
    shake.strength = strength;
}

const baseCameraPos = camera.position.clone();

function updateShake(delta) {
    if (shake.time <= 0) return;
    shake.time -= delta;

    camera.position.x = baseCameraPos.x + (Math.random() - 0.5) * shake.strength;
    camera.position.y = baseCameraPos.y + (Math.random() - 0.5) * shake.strength;

    if (shake.time <= 0) {
        camera.position.copy(baseCameraPos);
    }
}
```

### Screen Flash

Overlay a full-screen quad (simple approach: CSS overlay):

```javascript
// HTML: <div id="flash"></div>
// CSS: #flash { position: fixed; inset: 0; background: white; opacity: 0; pointer-events: none; }

function flash(duration = 0.1) {
    const el = document.getElementById('flash');
    el.style.transition = 'none';
    el.style.opacity = '1';
    requestAnimationFrame(() => {
        el.style.transition = `opacity ${duration}s ease-out`;
        el.style.opacity = '0';
    });
}
```

### Zoom Pulse

```javascript
function zoomPulse(amount = 0.2, duration = 0.1) {
    const startFov = camera.fov;
    camera.fov = startFov - startFov * amount;
    camera.updateProjectionMatrix();

    setTimeout(() => {
        camera.fov = startFov;
        camera.updateProjectionMatrix();
    }, duration * 1000);
}
```

---

## Squash & Stretch

Create a squash effect on impact:

```javascript
function squash(mesh, { x = 1.2, y = 0.8, z = 1.2, duration = 0.1 } = {}) {
    mesh.scale.set(x, y, z);
    setTimeout(() => mesh.scale.set(1, 1, 1), duration * 1000);
}
```

---

## Parallax Background Layers

Move layers at different speeds:

```javascript
const layers = [
    { mesh: layer1, speed: 0.2 },
    { mesh: layer2, speed: 0.5 },
    { mesh: layer3, speed: 1.0 }
];

function updateParallax(delta, playerVelocityX) {
    for (const layer of layers) {
        layer.mesh.position.x -= playerVelocityX * layer.speed * delta;
    }
}
```

---

## Object Pooling

Reuse objects instead of creating/destroying constantly:

```javascript
function createPool(factory, size = 50) {
    const pool = Array.from({ length: size }, factory);
    const active = new Set();

    function acquire() {
        const obj = pool.pop() || factory();
        active.add(obj);
        return obj;
    }

    function release(obj) {
        active.delete(obj);
        pool.push(obj);
    }

    return { acquire, release, active };
}
```

---

## Fixed Game Camera (Not OrbitControls)

Keep camera locked with follow smoothing:

```javascript
const follow = {
    target: player,
    offset: new THREE.Vector3(0, 5, 10),
    smooth: 0.1
};

function updateCamera() {
    const desired = follow.target.position.clone().add(follow.offset);
    camera.position.lerp(desired, follow.smooth);
    camera.lookAt(follow.target.position);
}
```

---

## Near-Miss Detection

Detect close calls (use distances):

```javascript
function nearMiss(a, b, threshold = 1) {
    return a.position.distanceTo(b.position) < threshold;
}
```

---

## Floating Text Popup

Create damage numbers:

```javascript
function spawnPopup(text, position) {
    const sprite = createTextSprite(text); // see advanced-topics.md for a text sprite helper
    sprite.position.copy(position);
    scene.add(sprite);

    const startY = sprite.position.y;
    let t = 0;
    const duration = 0.6;

    function update(delta) {
        t += delta;
        sprite.position.y = startY + t * 1.5;
        sprite.material.opacity = Math.max(0, 1 - t / duration);

        if (t >= duration) {
            scene.remove(sprite);
            sprite.material.map.dispose();
            sprite.material.dispose();
        }
    }

    return update;
}
```

---

## Best Practices Summary

- Keep game state explicit (state machine)
- Use pooling for bullets/particles
- Update mixers with `delta`
- Avoid heavy post-processing for mobile
- Prefer fixed camera for gameplay clarity

---

## Anti-Patterns

❌ **OrbitControls for gameplay camera**
Why bad: Players lose direction; camera fights inputs
Better: Fixed follow camera, limited rotation, or scripted cameras

❌ **Spawning new meshes constantly**
Why bad: GC spikes and frame drops
Better: Object pooling and instancing

❌ **Driving logic by frame count**
Why bad: Different FPS changes gameplay speed
Better: Always use `delta` time

