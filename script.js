/* Version 4.0.4 (Errors Fixed) */

// -- DOM Elements --
const imageLoader = document.getElementById('imageLoader');
const folderLoader = document.getElementById('folderLoader');
const jsonLoader = document.getElementById('jsonLoader');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Top-level controls
const saveButton = document.getElementById('saveButton');
const detectButton = document.getElementById('detectButton');
const colorPicker = document.getElementById('colorPicker');

// Project Directory & Session
const selectDirButton = document.getElementById('selectDirButton');
const clearCacheButton = document.getElementById('clearCacheButton');
const dirStatus = document.getElementById('dirStatus');

// Navigation
const prevImageButton = document.getElementById('prevImage');
const nextImageButton = document.getElementById('nextImage');
const imageCounter = document.getElementById('image-counter');

// Scene-level inputs
const sceneDescriptionInput = document.getElementById('sceneDescription');
const frameThemeInput = document.getElementById('frameTheme');
const backgroundThemeInput = document.getElementById('backgroundTheme');
const isMatchSelect = document.getElementById('isMatch');
const styleInput = document.getElementById('styleInput');
const sourceInput = document.getElementById('sourceInput');
const artistInput = document.getElementById('artistInput');
const sceneInputs = [sceneDescriptionInput, frameThemeInput, backgroundThemeInput, isMatchSelect, styleInput, sourceInput, artistInput];

// Annotation list and object-level inputs
const captionsDiv = document.getElementById('captions');
const labelInput = document.getElementById('labelInput');
const objectDescriptionInput = document.getElementById('objectDescription');
const objectAttributesInput = document.getElementById('objectAttributes');
const updateAnnotationButton = document.getElementById('updateAnnotationButton');
const deleteButton = document.getElementById('deleteButton');

// -- App State --
let currentImage, currentImageFileHandle;
let annotations = [];
let selectedAnnotation = null;
let highlightedAnnotation = null;
let workingDirectoryHandle = null;
let imageDirectoryHandle = null;
let categoryMap = {};
let imageFiles = [];
let currentImageIndex = -1;

let isDrawing = false;
let startX, startY, currentBox;
const CLICK_DRAG_THRESHOLD = 5;
const CACHE_KEY_STATE_PREFIX = 'annotationTool_state_';

// -- Initialization --
document.addEventListener('DOMContentLoaded', () => {
    updateNavigationUI();
});

// -- Event Listeners --

imageLoader.addEventListener('change', handleSingleImageLoad);
folderLoader.addEventListener('click', handleFolderLoad);
jsonLoader.addEventListener('change', handleJsonLoad);
detectButton.addEventListener('click', detectObjects);

selectDirButton.addEventListener('click', async () => {
    try {
        workingDirectoryHandle = await window.showDirectoryPicker({ id: 'workingDir', mode: 'readwrite' });
        updateDirectoryStatus(true, `Save directory set: ${workingDirectoryHandle.name}`);
        await loadCategoryMap();
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Error selecting save directory:', err);
            updateDirectoryStatus(false, 'Error selecting directory.');
        }
    }
});

clearCacheButton.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all cached annotation data for all images?')) {
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith(CACHE_KEY_STATE_PREFIX)) {
                localStorage.removeItem(key);
            }
        });
        alert('All cached annotation data has been cleared.');
        resetStateForNewImage();
        redraw();
    }
});

prevImageButton.addEventListener('click', () => navigateImage(-1));
nextImageButton.addEventListener('click', () => navigateImage(1));
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') navigateImage(-1);
    if (e.key === 'ArrowRight') navigateImage(1);
});

saveButton.addEventListener('click', saveAnnotation);

[...sceneInputs, labelInput, objectDescriptionInput, objectAttributesInput].forEach(input => {
    input.addEventListener('change', saveStateToCache);
});

updateAnnotationButton.addEventListener('click', () => {
    if (selectedAnnotation === null) { alert('Select an annotation to update.'); return; }
    const annotation = annotations[selectedAnnotation];
    annotation.label = labelInput.value.trim();
    annotation.description = objectDescriptionInput.value.trim();
    annotation.attributes = objectAttributesInput.value.split(',').map(attr => attr.trim()).filter(Boolean);
    redraw();
});

deleteButton.addEventListener('click', () => {
    if (selectedAnnotation === null) { alert('Select an annotation to delete.'); return; }
    annotations.splice(selectedAnnotation, 1);
    selectedAnnotation = null;
    updateEditFields(null);
    redraw();
});

canvas.addEventListener('mousedown', (e) => {
    if (!currentImage) return;
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    startX = (e.clientX - rect.left) * (canvas.width / rect.width);
    startY = (e.clientY - rect.top) * (canvas.height / rect.height);
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing || !currentImage) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    currentBox = { box: [Math.min(startX, x), Math.min(startY, y), Math.max(startX, x), Math.max(startY, y)] };
    redrawCanvas(); // This will redraw from scratch
});

canvas.addEventListener('mouseup', (e) => {
    if (!isDrawing || !currentImage) return;
    const rect = canvas.getBoundingClientRect();
    const endX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const endY = (e.clientY - rect.top) * (canvas.height / rect.height);
    const distance = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
    isDrawing = false;

    if (distance > CLICK_DRAG_THRESHOLD) {
        if (currentBox) {
            annotations.push({ label: 'new annotation', box: currentBox.box, description: '', attributes: [] });
            selectedAnnotation = annotations.length - 1;
            updateEditFields(selectedAnnotation);
            labelInput.focus();
        }
    } else {
        selectedAnnotation = getAnnotationAt(startX, startY);
        updateEditFields(selectedAnnotation);
    }
    currentBox = null;
    redraw();
});

// -- File and Folder Handling --

async function handleFolderLoad() {
    try {
        imageDirectoryHandle = await window.showDirectoryPicker({ id: 'imageDir', mode: 'read' });
        imageFiles = [];
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        for await (const entry of imageDirectoryHandle.values()) {
            if (entry.kind === 'file' && imageExtensions.some(ext => entry.name.toLowerCase().endsWith(ext))) {
                imageFiles.push(entry);
            }
        }
        imageFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        if (imageFiles.length > 0) {
            await navigateImage(0, true);
        } else {
            alert('No valid images found in the selected folder.');
            currentImageIndex = -1;
            updateNavigationUI();
        }
        if (!workingDirectoryHandle) {
            workingDirectoryHandle = imageDirectoryHandle;
            updateDirectoryStatus(true, `Save directory set to: ${workingDirectoryHandle.name}`);
            await loadCategoryMap();
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.error('Error loading folder:', err);
    }
}

async function handleSingleImageLoad(e) {
    if (!e.target.files || e.target.files.length === 0) return;
    imageDirectoryHandle = null;
    imageFiles = [];
    currentImageIndex = -1;
    const file = e.target.files[0];
    currentImageFileHandle = { name: file.name, getFile: async () => file };
    await loadImageFromFile(file);
    updateNavigationUI();
}

function handleJsonLoad(e) {
    if (!e.target.files || e.target.files.length === 0) return;
    if (!currentImage) {
        alert('Please load an image before loading annotations.');
        e.target.value = ''; return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            loadAnnotationData(JSON.parse(event.target.result));
            alert('Annotation data loaded successfully.');
        } catch (error) {
            console.error("Error parsing JSON:", error);
            alert("Failed to parse JSON file.");
        }
    };
    reader.readAsText(e.target.files[0]);
}

async function loadImageByIndex(index) {
    if (index < 0 || index >= imageFiles.length) return;
    currentImageIndex = index;
    currentImageFileHandle = imageFiles[index];
    const file = await currentImageFileHandle.getFile();
    await loadImageFromFile(file);
    updateNavigationUI();
}

async function loadImageFromFile(file) {
    const imgSrc = URL.createObjectURL(file);
    const img = new Image();
    img.src = imgSrc;
    await img.decode();
    
    canvas.width = img.width;
    canvas.height = img.height;
    currentImage = img;
    
    // Clear canvas completely before drawing new image
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    resetStateForNewImage();
    
    if (!loadStateFromCache()) {
        await autoLoadAnnotationForCurrentImage();
    }
    
    redraw();
    URL.revokeObjectURL(imgSrc);
}

async function navigateImage(direction, absolute = false) {
    if (imageFiles.length === 0 && !absolute) return;
    const newIndex = absolute ? direction : currentImageIndex + direction;
    if (newIndex >= 0 && newIndex < imageFiles.length) {
        await loadImageByIndex(newIndex);
    }
}

// -- Data and State Persistence --

function getCacheKeyState() {
    if (!currentImageFileHandle) return null;
    return CACHE_KEY_STATE_PREFIX + currentImageFileHandle.name;
}

function saveStateToCache() {
    const stateKey = getCacheKeyState();
    if (!currentImage || !stateKey) return;

    const state = {
        annotations,
        sceneDescription: sceneDescriptionInput.value,
        frameTheme: frameThemeInput.value,
        backgroundTheme: backgroundThemeInput.value,
        isMatch: isMatchSelect.value,
        style: styleInput.value,
        source: sourceInput.value,
        artist: artistInput.value,
        selectedAnnotation
    };
    try {
        localStorage.setItem(stateKey, JSON.stringify(state));
    } catch (e) {
        console.error("Error saving state to cache:", e);
        alert("Could not save annotation progress to browser cache.");
    }
}

function loadStateFromCache() {
    const stateKey = getCacheKeyState();
    if (!stateKey) return false;

    const cachedStateJSON = localStorage.getItem(stateKey);

    if (cachedStateJSON) {
        console.log("Loading unsaved work from cache for:", currentImageFileHandle.name);
        const state = JSON.parse(cachedStateJSON);
        loadState(state);
        return true;
    }
    return false;
}

function loadState(state) {
    annotations = state.annotations || [];
    sceneDescriptionInput.value = state.sceneDescription || '';
    frameThemeInput.value = state.frameTheme || '';
    backgroundThemeInput.value = state.backgroundTheme || '';
    isMatchSelect.value = state.isMatch || 'true';
    styleInput.value = state.style || '';
    sourceInput.value = state.source || '';
    artistInput.value = state.artist || '';
    selectedAnnotation = state.selectedAnnotation !== undefined ? state.selectedAnnotation : null;
    updateEditFields(selectedAnnotation);
}

async function saveAnnotation() {
    if (!currentImage || !workingDirectoryHandle || !currentImageFileHandle) {
        alert('Please load an image and select a save directory first.');
        return;
    }
    try {
        updateCategoryMapFromAnnotations();

        const baseFilename = currentImageFileHandle.name.substring(0, currentImageFileHandle.name.lastIndexOf('.') || currentImageFileHandle.name.length);
        const jsonFilename = `${baseFilename}.json`;
        const categoryFilename = 'category_map.json';

        const finalJsonData = createFinalJson(baseFilename, `${baseFilename}.jpg`);

        await saveFileToDirectory(jsonFilename, new Blob([JSON.stringify(finalJsonData, null, 2)], { type: 'application/json' }));
        await saveFileToDirectory(categoryFilename, new Blob([JSON.stringify(categoryMap, null, 2)], { type: 'application/json' }));
        
        console.log(`Saved annotation file: ${jsonFilename}`);
        
        const stateKey = getCacheKeyState();
        if (stateKey) localStorage.removeItem(stateKey);
        
        alert(`Saved annotations for ${currentImageFileHandle.name}`);

    } catch (error) {
        console.error('File saving failed:', error);
        alert('Could not save files. See console for details.');
    }
}

async function autoLoadAnnotationForCurrentImage() {
    if (!workingDirectoryHandle || !currentImageFileHandle) return;
    const imageFileName = currentImageFileHandle.name;
    const jsonFileName = imageFileName.substring(0, imageFileName.lastIndexOf('.') || imageFileName.length) + '.json';

    try {
        const jsonFileHandle = await workingDirectoryHandle.getFileHandle(jsonFileName, { create: false });
        const file = await jsonFileHandle.getFile();
        const content = await file.text();
        loadAnnotationData(JSON.parse(content));
        console.log(`Loaded saved annotation file: ${jsonFileName}`);
    } catch (error) {
        if (error.name === 'NotFoundError') {
            console.log(`No saved annotation file for ${imageFileName}.`);
        } else {
            console.error(`Error auto-loading JSON for ${imageFileName}:`, error);
        }
    }
}

function loadAnnotationData(data) {
    loadState(data);
    if (data.objects) {
        data.objects.forEach(obj => {
            if (obj.label && obj.category_id && !categoryMap[obj.label]) {
                categoryMap[obj.label] = obj.category_id;
            }
        });
    }
}

// -- Helper & Utility Functions --

// Helper to convert blob to base64
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function detectObjects() {
    if (!currentImage) {
        alert("Please load an image first.");
        return;
    }
    detectButton.textContent = "Detecting...";
    detectButton.disabled = true;

    try {
        const imageBlob = await getCanvasBlob('image/png');
        const imageB64 = await blobToBase64(imageBlob);

        const response = await fetch('http://127.0.0.1:8000/detect-objects', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ image_b64: imageB64 })
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}: ${await response.text()}`);
        }

        const result = await response.json();
        const detections = result.objects;

        detections.forEach(det => {
            const [x1, y1, x2, y2] = det.box;
            annotations.push({
                label: det.label,
                box: [x1, y1, x2, y2],
                description: '',
                attributes: []
            });
        });
        redraw();

    } catch (error) {
        console.error("Object detection failed:", error);
        alert("Object detection failed. Ensure the backend service is running on port 8000 and check the browser console for details.");
    } finally {
        detectButton.textContent = "Detect Objects";
        detectButton.disabled = false;
    }
}

function resetStateForNewImage() {
    annotations = [];
    selectedAnnotation = null;
    highlightedAnnotation = null;
    jsonLoader.value = '';

    sceneInputs.forEach(input => {
        if (input.tagName === 'SELECT') {
            input.value = 'true';
        } else {
            input.value = '';
        }
    });
    updateEditFields(null);
}

function redraw() {
    redrawCanvas();
    updateCaptionsList();
    saveStateToCache();
}

async function loadCategoryMap() {
    if (!workingDirectoryHandle) return;
    try {
        const categoryFileHandle = await workingDirectoryHandle.getFileHandle('category_map.json');
        const file = await categoryFileHandle.getFile();
        const content = await file.text();
        categoryMap = JSON.parse(content);
        updateDirectoryStatus(true, `Save directory: ${workingDirectoryHandle.name}. Category map loaded.`);
    } catch (error) {
        if (error.name === 'NotFoundError') {
            categoryMap = {};
            updateDirectoryStatus(true, `Save directory: ${workingDirectoryHandle.name}. New category map will be created.`);
        } else {
            console.error('Error loading category map:', error);
            updateDirectoryStatus(false, 'Error loading category map.');
        }
    }
}

function updateDirectoryStatus(success, message = '') {
    dirStatus.classList.remove('success', 'error');
    if (success) {
        dirStatus.classList.add('success');
        dirStatus.textContent = message || `Directory: ${workingDirectoryHandle.name}`;
    } else {
        dirStatus.classList.add('error');
        dirStatus.textContent = message || 'No directory selected.';
    }
}

function updateNavigationUI() {
    if (imageFiles.length > 0) {
        imageCounter.textContent = `Image ${currentImageIndex + 1} of ${imageFiles.length}`;
        prevImageButton.disabled = currentImageIndex === 0;
        nextImageButton.disabled = currentImageIndex === imageFiles.length - 1;
    } else {
        imageCounter.textContent = 'No folder loaded';
        prevImageButton.disabled = true;
        nextImageButton.disabled = true;
    }
}

async function getCanvasBlob(format = 'image/png') {
    return new Promise(resolve => canvas.toBlob(resolve, format, 0.95));
}

async function saveFileToDirectory(filename, data) {
    const fileHandle = await workingDirectoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
}

function updateCategoryMapFromAnnotations() {
    let maxId = Object.values(categoryMap).reduce((max, id) => Math.max(max, id), 0);
    annotations.forEach(ann => {
        const label = ann.label.trim();
        if (label && !categoryMap[label]) {
            maxId++;
            categoryMap[label] = maxId;
        }
    });
}

function createFinalJson(imageId, imagePath) {
    const objects = annotations.map((ann, index) => {
        const label = ann.label.trim();
        if (!label) {
            console.warn(`Annotation ${index + 1} has an empty label and will be skipped.`);
            return null;
        }
        const categoryId = categoryMap[label];
        if (!categoryId) {
            console.warn(`Label "${label}" not in category map. It will be added on next save.`);
        }
        return {
            id: index + 1,
            label: label,
            category_id: categoryId,
            bbox: [ann.box[0], ann.box[1], ann.box[2] - ann.box[0], ann.box[3] - ann.box[1]],
            description: ann.description,
            attributes: ann.attributes
        };
    }).filter(Boolean);

    return {
        image_id: imageId,
        image_path: `data/images/${imagePath}`,
        scene_description: sceneDescriptionInput.value,
        theme_match: isMatchSelect.value === 'true',
        objects: objects,
        metadata: {
            style: styleInput.value,
            source: sourceInput.value,
            artist: artistInput.value,
            resolution: `${currentImage.width}x${currentImage.height}`
        }
    };
}

function updateEditFields(index) {
    if (index === null || !annotations[index]) {
        labelInput.value = '';
        objectDescriptionInput.value = '';
        objectAttributesInput.value = '';
    } else {
        const ann = annotations[index];
        labelInput.value = ann.label;
        objectDescriptionInput.value = ann.description;
        objectAttributesInput.value = ann.attributes.join(', ');
    }
}

function getAnnotationAt(x, y) {
    const clicked = annotations.map((ann, index) => {
        const box = ann.box;
        if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) {
            const area = (box[2] - box[0]) * (box[3] - box[1]);
            return { index, area };
        }
        return null;
    }).filter(Boolean);

    if (clicked.length === 0) return null;
    return clicked.sort((a, b) => a.area - b.area)[0].index;
}

function redrawCanvas() {
    if (!currentImage) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }
    // Clear the canvas completely first to avoid drawing artifacts
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(currentImage, 0, 0);

    annotations.forEach((ann, index) => {
        ctx.lineWidth = 2;
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        if (index === selectedAnnotation) {
            ctx.strokeStyle = '#00FF00';
            ctx.lineWidth = 4;
        } else if (index === highlightedAnnotation) {
            ctx.strokeStyle = colorPicker.value;
            ctx.lineWidth = 4;
            ctx.shadowColor = 'yellow';
            ctx.shadowBlur = 10;
        } else {
            ctx.strokeStyle = colorPicker.value;
        }
        
        const [x1, y1, x2, y2] = ann.box;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        
        ctx.font = '20px Arial';
        ctx.fillStyle = (index === selectedAnnotation) ? '#00FF00' : colorPicker.value;
        ctx.fillText(index + 1, x1, y1 - 5);
    });

    if (currentBox) {
        ctx.strokeStyle = colorPicker.value;
        ctx.lineWidth = 2;
        const [x1, y1, x2, y2] = currentBox.box;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
}

function updateCaptionsList() {
    captionsDiv.innerHTML = '';
    annotations.forEach((ann, index) => {
        const captionItem = document.createElement('div');
        captionItem.className = 'caption-item';
        if (index === selectedAnnotation) { captionItem.classList.add('selected'); }
        captionItem.textContent = `${index + 1}. ${ann.label}`;

        captionItem.addEventListener('mouseover', () => { highlightedAnnotation = index; redrawCanvas(); });
        captionItem.addEventListener('mouseout', () => { highlightedAnnotation = null; redrawCanvas(); });
        captionItem.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedAnnotation = index;
            updateEditFields(index);
            redraw();
        });
        captionsDiv.appendChild(captionItem);
    });
}