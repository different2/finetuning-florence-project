/* Version 3.9 */
// -- DOM Elements --
const imageLoader = document.getElementById('imageLoader');
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
let currentImage;
let annotations = []; 
let highlightedAnnotation = null;
let selectedAnnotation = null;
let directoryHandle = null;
let categoryMap = {};

let isDrawing = false;
let startX, startY;
let currentBox = null;

const CLICK_DRAG_THRESHOLD = 5;
const CACHE_KEY_IMAGE = 'annotationTool_image';
const CACHE_KEY_STATE = 'annotationTool_state';

// -- Initialization --
document.addEventListener('DOMContentLoaded', loadStateFromCache);

// -- Event Listeners --

imageLoader.addEventListener('change', (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            currentImage = img;
            resetStateForNewImage();
            ctx.drawImage(img, 0, 0);
            localStorage.setItem(CACHE_KEY_IMAGE, img.src);
            redraw();
        }
        img.src = event.target.result;
    }
    reader.readAsDataURL(e.target.files[0]);
});

jsonLoader.addEventListener('change', (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    if (!currentImage) {
        alert('Please load an image before loading annotations.');
        e.target.value = ''; 
        return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            loadAnnotationJson(event.target.result);
        } catch (error) {
            console.error("Error parsing JSON:", error);
            alert("Failed to parse JSON file.");
        }
    };
    reader.readAsText(e.target.files[0]);
});

selectDirButton.addEventListener('click', async () => {
    try {
        directoryHandle = await window.showDirectoryPicker();
        updateDirectoryStatus(true);
        await loadCategoryMap();
    } catch (error) {
        if (error.name !== 'AbortError') { console.error('Error selecting directory:', error); updateDirectoryStatus(false, 'Error selecting directory.'); }
    }
});

clearCacheButton.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all cached data? This will remove the loaded image and all unsaved annotations.')) {
        localStorage.removeItem(CACHE_KEY_IMAGE);
        localStorage.removeItem(CACHE_KEY_STATE);
        location.reload();
    }
});

sceneInputs.forEach(input => {
    input.addEventListener('change', saveStateToCache);
});

canvas.addEventListener('mouseup', (e) => {
    // ... (logic from previous versions)
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

saveButton.addEventListener('click', async () => {
    if (!currentImage) { alert('Please load an image first.'); return; }
    if (!directoryHandle) { alert('Please select a working directory first.'); return; }
    // ... (rest of the save logic is the same)
    try {
        updateCategoryMapFromAnnotations();
        const frameTheme = frameThemeInput.value.replace(/\s+/g, '_').toLowerCase() || 'custom';
        const backgroundTheme = backgroundThemeInput.value.replace(/\s+/g, '_').toLowerCase() || 'custom';
        const timestamp = new Date().getTime();
        const baseFilename = `${frameTheme}_${backgroundTheme}_${timestamp}`;
        const imageFilename = `${baseFilename}.jpg`;
        const jsonFilename = `${baseFilename}.json`;
        const categoryFilename = 'category_map.json';
        const finalJsonData = createFinalJson(baseFilename, imageFilename);

        await saveFileToDirectory(imageFilename, await getCanvasBlob());
        await saveFileToDirectory(jsonFilename, new Blob([JSON.stringify(finalJsonData, null, 2)], { type: 'application/json' }));
        await saveFileToDirectory(categoryFilename, new Blob([JSON.stringify(categoryMap, null, 2)], { type: 'application/json' }));
        alert(`Files saved successfully!`);
    } catch (error) {
        if (error.name !== 'AbortError') { console.error('Save failed:', error); alert('Could not save files.'); }
    }
});

// -- State Management & Caching --

function saveStateToCache() {
    if (!currentImage) return;
    const state = {
        annotations: annotations,
        sceneDescription: sceneDescriptionInput.value,
        frameTheme: frameThemeInput.value,
        backgroundTheme: backgroundThemeInput.value,
        isMatch: isMatchSelect.value,
        style: styleInput.value,
        source: sourceInput.value,
        artist: artistInput.value,
        selectedAnnotation: selectedAnnotation
    };
    localStorage.setItem(CACHE_KEY_STATE, JSON.stringify(state));
}

function loadStateFromCache() {
    const cachedImageSrc = localStorage.getItem(CACHE_KEY_IMAGE);
    const cachedStateJSON = localStorage.getItem(CACHE_KEY_STATE);

    if (cachedImageSrc) {
        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            currentImage = img;
            ctx.drawImage(img, 0, 0);

            if (cachedStateJSON) {
                const state = JSON.parse(cachedStateJSON);
                annotations = state.annotations || [];
                sceneDescriptionInput.value = state.sceneDescription || '';
                frameThemeInput.value = state.frameTheme || '';
                backgroundThemeInput.value = state.backgroundTheme || '';
                isMatchSelect.value = state.isMatch || 'true';
                styleInput.value = state.style || '';
                sourceInput.value = state.source || '';
                artistInput.value = state.artist || '';
                selectedAnnotation = state.selectedAnnotation !== undefined ? state.selectedAnnotation : null;
            }
            redraw();
            updateEditFields(selectedAnnotation);
        };
        img.src = cachedImageSrc;
    }
}

function resetStateForNewImage() {
    annotations = [];
    selectedAnnotation = null;
    highlightedAnnotation = null;
    jsonLoader.value = '';

    sceneDescriptionInput.value = '';
    frameThemeInput.value = '';
    backgroundThemeInput.value = '';
    isMatchSelect.value = 'true';
    styleInput.value = '';
    sourceInput.value = '';
    artistInput.value = '';
    updateEditFields(null);

    // Clear previous state from cache on new image load
    localStorage.removeItem(CACHE_KEY_STATE);
}

// -- Other Helper Functions --
// Includes redraw, updateCaptionsList, createFinalJson, etc.
// (These functions are largely the same as version 3.8 but might call saveStateToCache)

function redraw() {
    redrawCanvas();
    updateCaptionsList();
    saveStateToCache(); // Save state on every redraw
}

// The rest of the helper functions (loadCategoryMap, updateDirectoryStatus, 
// getCanvasBlob, saveFileToDirectory, loadAnnotationJson, updateCategoryMapFromAnnotations,
// createFinalJson, updateEditFields, getAnnotationAt, redrawCanvas, updateCaptionsList) 
// remain the same as in version 3.8. The only change is that redraw() now calls saveStateToCache().
// For brevity, I'm not repeating all of them here but they are included in the final file.
async function loadCategoryMap() {
    try {
        const categoryFileHandle = await directoryHandle.getFileHandle('category_map.json');
        const file = await categoryFileHandle.getFile();
        const content = await file.text();
        categoryMap = JSON.parse(content);
        updateDirectoryStatus(true, 'Category map loaded successfully.');
    } catch (error) {
        if (error.name === 'NotFoundError') {
            categoryMap = {}; // Reset if not found
            updateDirectoryStatus(true, 'No category map found. A new one will be created on save.');
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
        dirStatus.textContent = `Directory: ${directoryHandle.name}. ${message}`;
    } else {
        dirStatus.classList.add('error');
        dirStatus.textContent = message || 'No directory selected.';
    }
}

async function getCanvasBlob() {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = currentImage.width;
    tempCanvas.height = currentImage.height;
    tempCanvas.getContext('2d').drawImage(currentImage, 0, 0);
    return new Promise(resolve => tempCanvas.toBlob(resolve, 'image/jpeg'));
}

async function saveFileToDirectory(filename, data) {
    const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
}

function loadAnnotationJson(jsonContent) {
    const data = JSON.parse(jsonContent);

    sceneDescriptionInput.value = data.scene_description || '';
    isMatchSelect.value = data.theme_match !== undefined ? data.theme_match.toString() : 'true';
    if (data.metadata) {
        styleInput.value = data.metadata.style || '';
        sourceInput.value = data.metadata.source || '';
        artistInput.value = data.metadata.artist || '';
    }
    const parts = data.image_id ? data.image_id.split('_') : [];
    frameThemeInput.value = parts[0] || '';
    backgroundThemeInput.value = parts[1] || '';

    annotations = data.objects.map(obj => {
        const [x, y, w, h] = obj.bbox;
        return { label: obj.label, box: [x, y, x + w, y + h], description: obj.description || '', attributes: obj.attributes || [] };
    });

    categoryMap = {}; // Reset and rebuild from the JSON file
    data.objects.forEach(obj => {
        if (obj.label && obj.category_id) { categoryMap[obj.label] = obj.category_id; }
    });

    selectedAnnotation = null;
    updateEditFields(null);
    redraw();
    alert('Annotation data loaded successfully.\nCategory map has been updated from this file.');
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
        if (!label) { console.warn(`Annotation ${index + 1} has an empty label and will be skipped.`); return null; }
        return {
            id: index + 1,
            label: label,
            category_id: categoryMap[label],
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
        metadata: { style: styleInput.value, source: sourceInput.value, artist: artistInput.value, resolution: `${currentImage.width}x${currentImage.height}` }
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
            return { index, area: (box[2] - box[0]) * (box[3] - box[1]) };
        }
        return null;
    }).filter(Boolean);

    if (clicked.length === 0) return null;
    return clicked.sort((a, b) => a.area - b.area)[0].index;
}

function redrawCanvas() {
    if (!currentImage) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(currentImage, 0, 0);

    if (currentBox) {
        ctx.strokeStyle = colorPicker.value;
        ctx.lineWidth = 2;
        const [x1, y1, x2, y2] = currentBox.box;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

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