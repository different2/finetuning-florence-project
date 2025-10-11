/* Version 5.3 (JSON Loading Fix) */

// -- DOM Elements --
// File Inputs
const imageLoader = document.getElementById('imageLoader');
const jsonLoader = document.getElementById('jsonLoader');

// Canvas
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Menu Links
const loadSingleImageLink = document.getElementById('loadSingleImage');
const loadFolderLink = document.getElementById('loadFolder');
const setSaveDirectoryLink = document.getElementById('setSaveDirectory');
const saveAnnotationsLink = document.getElementById('saveAnnotations');
const detectObjectsLink = document.getElementById('detectObjects');
const importJsonLink = document.getElementById('importJson');
const clearAllCacheLink = document.getElementById('clearAllCache');

// Status & Navigation
const dirStatus = document.getElementById('dirStatus');
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
const colorPicker = document.getElementById('colorPicker');

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
let isSingleImageMode = false;

let isDrawing = false;
let startX, startY, currentBox;
const CLICK_DRAG_THRESHOLD = 5;
const CACHE_KEY_STATE_PREFIX = 'annotationTool_state_';

// -- Initialization --
document.addEventListener('DOMContentLoaded', () => {
    // Wire up menu items to trigger actions or hidden file inputs
    loadSingleImageLink.addEventListener('click', (e) => { e.preventDefault(); imageLoader.click(); });
    loadFolderLink.addEventListener('click', (e) => { e.preventDefault(); handleFolderLoad(); });
    setSaveDirectoryLink.addEventListener('click', (e) => { e.preventDefault(); selectSaveDirectory(); });
    saveAnnotationsLink.addEventListener('click', (e) => { e.preventDefault(); saveAnnotation(); });
    detectObjectsLink.addEventListener('click', (e) => { e.preventDefault(); detectObjects(); });
    importJsonLink.addEventListener('click', (e) => { e.preventDefault(); jsonLoader.click(); });
    clearAllCacheLink.addEventListener('click', (e) => { e.preventDefault(); clearAllCache(); });
    
    // Listen for file selections
    imageLoader.addEventListener('change', handleSingleImageLoad);
    jsonLoader.addEventListener('change', handleJsonLoad);

    updateNavigationUI();
});

// -- Event Listeners (Primary Actions) --

function selectSaveDirectory() {
    window.showDirectoryPicker({ id: 'workingDir', mode: 'readwrite' }).then(async (handle) => {
        workingDirectoryHandle = handle;
        updateDirectoryStatus(true, `Save directory set: ${workingDirectoryHandle.name}`);
        await loadCategoryMap();
    }).catch(err => {
        if (err.name !== 'AbortError') {
            console.error('Error selecting save directory:', err);
            updateDirectoryStatus(false, 'Error selecting directory.');
        }
    });
}

function clearAllCache() {
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
}

prevImageButton.addEventListener('click', () => navigateImage(-1));
nextImageButton.addEventListener('click', () => navigateImage(1));
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') navigateImage(-1);
    if (e.key === 'ArrowRight') navigateImage(1);
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

// -- Canvas Drawing Events --
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
    redrawCanvas();
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
        isSingleImageMode = false;

        if (imageFiles.length > 0) {
            currentImageIndex = 0;
            await loadImageByIndex(0);
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
    const file = e.target.files[0];
    imageDirectoryHandle = null;
    imageFiles = [];
    currentImageIndex = -1;
    isSingleImageMode = true;
    currentImageFileHandle = { name: file.name, getFile: async () => file };
    await loadImageFromFile(file);
    updateNavigationUI();
    e.target.value = '';
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
            const data = JSON.parse(event.target.result);
            loadAnnotationData(data);
            redraw();
            alert('Annotation data loaded successfully.');
        } catch (error) {
            console.error("Error parsing JSON:", error);
            alert("Failed to parse JSON file.");
        }
    };
    reader.readAsText(e.target.files[0]);
    e.target.value = '';
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
    await new Promise(resolve => { img.onload = resolve; });
    canvas.width = img.width;
    canvas.height = img.height;
    currentImage = img;
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
    if (isSingleImageMode || imageFiles.length === 0) return;
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
    } catch (e) { console.error("Error saving state to cache:", e); }
}

function loadStateFromCache() {
    const stateKey = getCacheKeyState();
    if (!stateKey) return false;
    const cachedStateJSON = localStorage.getItem(stateKey);
    if (cachedStateJSON) {
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
    selectedAnnotation = (state.selectedAnnotation !== undefined && state.annotations && state.annotations.length > state.selectedAnnotation) ? state.selectedAnnotation : null;
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
        const imageFilename = `${baseFilename}.jpg`;
        const jsonFilename = `${baseFilename}.json`;
        const categoryFilename = 'category_map.json';
        const finalJsonData = createFinalJson(baseFilename, imageFilename);
        const imageBlob = await getCanvasBlob('image/jpeg', 0.9);
        await saveFileToDirectory(jsonFilename, new Blob([JSON.stringify(finalJsonData, null, 2)], { type: 'application/json' }));
        await saveFileToDirectory(imageFilename, imageBlob);
        await saveFileToDirectory(categoryFilename, new Blob([JSON.stringify(categoryMap, null, 2)], { type: 'application/json' }));
        alert(`Saved annotations and image for ${currentImageFileHandle.name}. Your work remains cached.`);
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
        redraw();
    } catch (error) {
        if (error.name !== 'NotFoundError') {
            console.error(`Error auto-loading JSON for ${imageFileName}:`, error);
        }
    }
}

function loadAnnotationData(data) {
    // Load scene-level fields
    sceneDescriptionInput.value = data.scene_description || '';
    frameThemeInput.value = data.frame_theme || '';
    backgroundThemeInput.value = data.background_theme || '';
    isMatchSelect.value = data.theme_match !== undefined ? String(data.theme_match) : 'true';
    
    // Load metadata fields
    if (data.metadata) {
        styleInput.value = data.metadata.style || '';
        sourceInput.value = data.metadata.source || '';
        artistInput.value = data.metadata.artist || '';
    } else {
        styleInput.value = '';
        sourceInput.value = '';
        artistInput.value = '';
    }
    
    // Load annotations from objects
    annotations = [];
    if (data.objects && Array.isArray(data.objects)) {
        data.objects.forEach(obj => {
            if (obj.bbox && obj.bbox.length === 4) {
                // Convert from [x, y, width, height] to [x1, y1, x2, y2]
                const box = [obj.bbox[0], obj.bbox[1], obj.bbox[0] + obj.bbox[2], obj.bbox[1] + obj.bbox[3]];
                annotations.push({
                    label: obj.label || 'unlabeled',
                    box: box,
                    description: obj.description || '',
                    attributes: obj.attributes || []
                });
            }
            // Update category map
            if (obj.label && obj.category_id && !categoryMap[obj.label]) {
                categoryMap[obj.label] = obj.category_id;
            }
        });
    }
    
    selectedAnnotation = null;
    updateEditFields(null);
}

// -- Helper & Utility Functions --
async function detectObjects() {
    if (!currentImage) { alert("Please load an image first."); return; }
    detectObjectsLink.textContent = "Detecting...";
    try {
        const imageBlob = await getCanvasBlob('image/png');
        const imageB64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(imageBlob);
        });
        const response = await fetch('http://127.0.0.1:8000/detect-objects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_b64: imageB64 })
        });
        if (!response.ok) throw new Error(`Server responded with ${response.status}: ${await response.text()}`);
        const result = await response.json();
        result.objects.forEach(det => {
            annotations.push({ label: det.label, box: det.box, description: '', attributes: [] });
        });
        redraw();
    } catch (error) {
        console.error("Object detection failed:", error);
        alert("Object detection failed. Ensure the backend service is running and check console.");
    } finally {
        detectObjectsLink.textContent = "Detect Objects";
    }
}

function resetStateForNewImage() {
    annotations = [];
    selectedAnnotation = null;
    highlightedAnnotation = null;
    jsonLoader.value = '';
    sceneInputs.forEach(input => {
        if (input.tagName === 'SELECT') input.value = 'true';
        else input.value = '';
    });
    updateEditFields(null);
}

function redraw() { redrawCanvas(); updateCaptionsList(); saveStateToCache(); }

async function loadCategoryMap() {
    if (!workingDirectoryHandle) return;
    try {
        const categoryFileHandle = await workingDirectoryHandle.getFileHandle('category_map.json');
        const file = await categoryFileHandle.getFile();
        categoryMap = JSON.parse(await file.text());
        updateDirectoryStatus(true, `Save directory: ${workingDirectoryHandle.name}. Category map loaded.`);
    } catch (error) {
        if (error.name === 'NotFoundError') {
            categoryMap = {};
            updateDirectoryStatus(true, `Save directory: ${workingDirectoryHandle.name}. New category map will be created.`);
        } else { console.error('Error loading category map:', error); updateDirectoryStatus(false, 'Error loading category map.'); }
    }
}

function updateDirectoryStatus(success, message = '') {
    dirStatus.classList.remove('success', 'error');
    if (success) { dirStatus.classList.add('success'); } else { dirStatus.classList.add('error'); }
    dirStatus.textContent = message;
}

function updateNavigationUI() {
    if (isSingleImageMode) {
        imageCounter.textContent = currentImageFileHandle ? currentImageFileHandle.name : 'Single Image';
        prevImageButton.disabled = true;
        nextImageButton.disabled = true;
    } else if (imageFiles.length > 0 && currentImageIndex >= 0) {
        imageCounter.textContent = `Image ${currentImageIndex + 1} of ${imageFiles.length}`;
        prevImageButton.disabled = currentImageIndex === 0;
        nextImageButton.disabled = currentImageIndex === imageFiles.length - 1;
    } else {
        imageCounter.textContent = 'No image loaded';
        prevImageButton.disabled = true;
        nextImageButton.disabled = true;
    }
}

async function getCanvasBlob(format = 'image/jpeg', quality = 0.9) { return new Promise(resolve => canvas.toBlob(resolve, format, quality)); }

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
        if (label && !categoryMap[label]) { categoryMap[label] = ++maxId; }
    });
}

function createFinalJson(imageId, imagePath) {
    const objects = annotations.map((ann, index) => {
        const label = ann.label.trim();
        if (!label) return null;
        return { id: index + 1, label: label, category_id: categoryMap[label], bbox: [ann.box[0], ann.box[1], ann.box[2] - ann.box[0], ann.box[3] - ann.box[1]], description: ann.description, attributes: ann.attributes };
    }).filter(Boolean);
    return { 
        image_id: imageId, 
        image_path: `data/images/${imagePath}`, 
        scene_description: sceneDescriptionInput.value,
        frame_theme: frameThemeInput.value,
        background_theme: backgroundThemeInput.value,
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
        objectDescriptionInput.value = ann.description || '';
        objectAttributesInput.value = (ann.attributes || []).join(', ');
    }
}

function getAnnotationAt(x, y) {
    const clicked = annotations.map((ann, index) => {
        const [x1, y1, x2, y2] = ann.box;
        if (x >= x1 && x <= x2 && y >= y1 && y <= y2) { return { index, area: (x2 - x1) * (y2 - y1) }; }
        return null;
    }).filter(Boolean);
    if (clicked.length === 0) return null;
    return clicked.sort((a, b) => a.area - b.area)[0].index;
}

function redrawCanvas() {
    if (!currentImage) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(currentImage, 0, 0);
    annotations.forEach((ann, index) => {
        ctx.lineWidth = (index === selectedAnnotation) ? 4 : 2;
        ctx.strokeStyle = (index === selectedAnnotation) ? '#00FF00' : colorPicker.value;
        ctx.shadowColor = (index === highlightedAnnotation) ? 'yellow' : 'transparent';
        ctx.shadowBlur = (index === highlightedAnnotation) ? 10 : 0;
        const [x1, y1, x2, y2] = ann.box;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.font = '20px Arial';
        ctx.fillStyle = ctx.strokeStyle;
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