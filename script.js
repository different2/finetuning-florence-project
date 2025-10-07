/* Version 2.8 */
const imageLoader = document.getElementById('imageLoader');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const saveButton = document.getElementById('saveButton');
const detectButton = document.getElementById('detectButton');
const colorPicker = document.getElementById('colorPicker');
const captionsDiv = document.getElementById('captions');

const frameThemeInput = document.getElementById('frameTheme');
const backgroundThemeInput = document.getElementById('backgroundTheme');
const isMatchSelect = document.getElementById('isMatch');

const labelInput = document.getElementById('labelInput');
const updateLabelButton = document.getElementById('updateLabelButton');
const deleteButton = document.getElementById('deleteButton');

let currentImage;
let annotations = [];
let highlightedAnnotation = null;
let selectedAnnotation = null;
let directoryHandle = null;

let isDrawing = false;
let startX, startY;
let currentBox = null;

const CLICK_DRAG_THRESHOLD = 5;

imageLoader.addEventListener('change', (e) => {
    if (!e.target.files || e.target.files.length === 0) {
        return; // No file selected
    }
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            // Only clear data if it's a new image
            if (!currentImage || currentImage.src !== img.src) {
                canvas.width = img.width;
                canvas.height = img.height;
                currentImage = img;

                // Clear all data for the new image
                annotations = [];
                selectedAnnotation = null;
                highlightedAnnotation = null;
                labelInput.value = '';
                frameThemeInput.value = '';
                backgroundThemeInput.value = '';
                isMatchSelect.value = 'true';
                directoryHandle = null; // Reset directory for new image session
            }
            ctx.drawImage(img, 0, 0); // Always draw the image
            redraw(); // Redraw annotations over it
        }
        img.src = event.target.result;
    }
    reader.readAsDataURL(e.target.files[0]);
});

colorPicker.addEventListener('input', redraw);

detectButton.addEventListener('click', async () => {
    if (!currentImage) {
        alert('Please load an image first.');
        return;
    }
    const image_b64 = canvas.toDataURL('image/jpeg').split(',')[1];
    try {
        const response = await fetch('http://127.0.0.1:8000/detect-objects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_b64: image_b64 })
        });
        if (!response.ok) { throw new Error(`HTTP error! status: ${response.status}`); }
        const data = await response.json();
        annotations = data.objects;
        redraw();
    } catch (error) {
        console.error('Error detecting objects:', error);
        alert('Error detecting objects. See console for details.');
    }
});

async function fallbackSave(imageFilename, jsonFilename) {
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    tempCanvas.width = currentImage.width;
    tempCanvas.height = currentImage.height;
    tempCtx.drawImage(currentImage, 0, 0);
    const imageDataUrl = tempCanvas.toDataURL('image/png');
    const imageBase64 = imageDataUrl.split(',')[1];

    const categories = createCategories();
    const cocoAnnotations = createCocoAnnotations(categories.categoryMap);

    const cocoData = {
        info: { description: 'Annotation created with custom tool', version: '1.0', year: new Date().getFullYear(), date_created: new Date().toISOString() },
        images: [{ id: 1, width: canvas.width, height: canvas.height, file_name: imageFilename }],
        annotations: cocoAnnotations,
        categories: categories.list,
        image_path: imageFilename,
        frame_theme: frameThemeInput.value,
        background_theme: backgroundThemeInput.value,
        is_match: isMatchSelect.value,
        image_data: imageBase64
    };

    const jsonBlob = new Blob([JSON.stringify(cocoData, null, 2)], { type: 'application/json' });
    const jsonUrl = URL.createObjectURL(jsonBlob);
    const jsonLink = document.createElement('a');
    jsonLink.href = jsonUrl;
    jsonLink.download = jsonFilename;
    jsonLink.click();
    URL.revokeObjectURL(jsonUrl);
}

function createCategories() {
    const list = [];
    const categoryMap = {};
    annotations.forEach(ann => {
        if (!categoryMap.hasOwnProperty(ann.label)) {
            const newCategory = { id: list.length + 1, name: ann.label, supercategory: 'object' };
            list.push(newCategory);
            categoryMap[ann.label] = newCategory.id;
        }
    });
    return { list, categoryMap };
}

function createCocoAnnotations(categoryMap) {
    return annotations.map((ann, index) => {
        const box = ann.box;
        const width = box[2] - box[0];
        const height = box[3] - box[1];
        return { id: index + 1, image_id: 1, category_id: categoryMap[ann.label], bbox: [box[0], box[1], width, height], area: width * height, iscrowd: 0 };
    });
}

saveButton.addEventListener('click', async () => {
    if (!currentImage) {
        alert('Please load an image first.');
        return;
    }

    const frameTheme = frameThemeInput.value.replace(/\s+/g, '_') || 'custom';
    const backgroundTheme = backgroundThemeInput.value.replace(/\s+/g, '_') || 'custom';
    const timestamp = new Date().getTime();
    const baseFilename = `${frameTheme}_${backgroundTheme}_${timestamp}`;
    const imageFilename = `${baseFilename}.png`;
    const jsonFilename = `${baseFilename}.json`;

    if ('showDirectoryPicker' in window) {
        try {
            if (!directoryHandle) {
                directoryHandle = await window.showDirectoryPicker();
            }

            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            tempCanvas.width = currentImage.width;
            tempCanvas.height = currentImage.height;
            tempCtx.drawImage(currentImage, 0, 0);
            const imageBlob = await new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));

            const categories = createCategories();
            const cocoAnnotations = createCocoAnnotations(categories.categoryMap);
            const cocoData = {
                info: { description: 'Annotation created with custom tool', version: '1.0', year: new Date().getFullYear(), date_created: new Date().toISOString() },
                images: [{ id: 1, width: canvas.width, height: canvas.height, file_name: imageFilename }],
                annotations: cocoAnnotations,
                categories: categories.list,
                image_path: imageFilename,
                frame_theme: frameThemeInput.value,
                background_theme: backgroundThemeInput.value,
                is_match: isMatchSelect.value
            };
            const jsonBlob = new Blob([JSON.stringify(cocoData, null, 2)], { type: 'application/json' });

            const imageFileHandle = await directoryHandle.getFileHandle(imageFilename, { create: true });
            const imageWritable = await imageFileHandle.createWritable();
            await imageWritable.write(imageBlob);
            await imageWritable.close();

            const jsonFileHandle = await directoryHandle.getFileHandle(jsonFilename, { create: true });
            const jsonWritable = await jsonFileHandle.createWritable();
            await jsonWritable.write(jsonBlob);
            await jsonWritable.close();

            alert('Files saved successfully!');

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('File System Access API failed:', error);
                alert('Could not save files to directory. Falling back to download method.');
                await fallbackSave(imageFilename, jsonFilename);
            } else {
                console.log('File save aborted by user.');
            }
        }
    } else {
        alert('Your browser does not support direct file saving. Using download method.');
        await fallbackSave(imageFilename, jsonFilename);
    }
});

canvas.addEventListener('mousedown', (e) => {
    if (!currentImage) return;
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing || !currentImage) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    currentBox = { box: [Math.min(startX, x), Math.min(startY, y), Math.max(startX, x), Math.max(startY, y)] };
    redraw();
});

canvas.addEventListener('mouseup', (e) => {
    if (!isDrawing || !currentImage) return;

    const rect = canvas.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;
    const distance = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));

    if (distance > CLICK_DRAG_THRESHOLD) {
        if (currentBox) {
            const label = prompt('Enter a label for the new bounding box:');
            if (label) {
                annotations.push({ label: label, box: currentBox.box });
                selectedAnnotation = annotations.length - 1;
                labelInput.value = label;
            }
        }
    } else {
        const clickedAnnotationIndex = getAnnotationAt(startX, startY);
        if (clickedAnnotationIndex !== null) {
            selectedAnnotation = clickedAnnotationIndex;
            labelInput.value = annotations[selectedAnnotation].label;
        } else {
            selectedAnnotation = null;
            labelInput.value = '';
        }
    }
    isDrawing = false;
    currentBox = null;
    redraw();
});

updateLabelButton.addEventListener('click', () => {
    if (selectedAnnotation !== null) {
        annotations[selectedAnnotation].label = labelInput.value;
        redraw();
    } else {
        alert('Please select a bounding box to update its label.');
    }
});

deleteButton.addEventListener('click', () => {
    if (selectedAnnotation !== null) {
        annotations.splice(selectedAnnotation, 1);
        selectedAnnotation = null;
        labelInput.value = '';
        redraw();
    } else {
        alert('Please select a bounding box to delete.');
    }
});

function getAnnotationAt(x, y) {
    for (let i = annotations.length - 1; i >= 0; i--) {
        const box = annotations[i].box;
        if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) {
            return i;
        }
    }
    return null;
}

function redraw() {
    if (!currentImage) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(currentImage, 0, 0);
    captionsDiv.innerHTML = '';

    if (currentBox) {
        ctx.strokeStyle = colorPicker.value;
        ctx.lineWidth = 2;
        ctx.strokeRect(currentBox.box[0], currentBox.box[1], currentBox.box[2] - currentBox.box[0], currentBox.box[3] - currentBox.box[1]);
    }

    annotations.forEach((annotation, index) => {
        ctx.strokeStyle = colorPicker.value;
        ctx.lineWidth = 2;
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        if (index === highlightedAnnotation) {
            ctx.lineWidth = 4;
            ctx.shadowColor = 'yellow';
            ctx.shadowBlur = 10;
        }
        if (index === selectedAnnotation) {
            ctx.lineWidth = 4;
            ctx.strokeStyle = '#00FF00';
        }

        const box_width = annotation.box[2] - annotation.box[0];
        const box_height = annotation.box[3] - annotation.box[1];
        ctx.strokeRect(annotation.box[0], annotation.box[1], box_width, box_height);

        ctx.font = '20px Arial';
        ctx.fillStyle = (index === selectedAnnotation) ? '#00FF00' : colorPicker.value;
        ctx.fillText(index + 1, annotation.box[0], annotation.box[1] - 5);

        const captionItem = document.createElement('div');
        captionItem.classList.add('caption-item');
        captionItem.textContent = `${index + 1}. ${annotation.label}`;
        if(index === selectedAnnotation){ captionItem.style.backgroundColor = '#e0ffe0'; }

        captionItem.addEventListener('mouseover', () => { highlightedAnnotation = index; redraw(); });
        captionItem.addEventListener('mouseout', () => { highlightedAnnotation = null; redraw(); });
        captionItem.addEventListener('click', () => {
            selectedAnnotation = index;
            labelInput.value = annotations[selectedAnnotation].label;
            redraw();
        });
        captionsDiv.appendChild(captionItem);
    });
}