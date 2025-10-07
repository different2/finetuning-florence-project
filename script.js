/* Version 1.1 */
const imageLoader = document.getElementById('imageLoader');
const canvas = document.getElementById('canvas');
const saveButton = document.getElementById('saveButton');
const detectButton = document.getElementById('detectButton');
const colorPicker = document.getElementById('colorPicker');
const captionsDiv = document.getElementById('captions');
const ctx = canvas.getContext('2d');

let currentImage;
let annotations = [];
let highlightedAnnotation = null;

imageLoader.addEventListener('change', (e) => {
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            currentImage = img;
            annotations = [];
            redraw();
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
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ image_b64: image_b64 })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        annotations = data.objects;
        redraw();
    } catch (error) {
        console.error('Error detecting objects:', error);
        alert('Error detecting objects. See console for details.');
    }
});

saveButton.addEventListener('click', () => {
    const saveData = {
        annotations: annotations,
    };
    const data = JSON.stringify(saveData, null, 2);
    const blob = new Blob([data], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotations.json';
    a.click();
    URL.revokeObjectURL(url);
});

function redraw() {
    if (!currentImage) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(currentImage, 0, 0);
    
    captionsDiv.innerHTML = ''; // Clear previous captions

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

        const box_width = annotation.box[2] - annotation.box[0];
        const box_height = annotation.box[3] - annotation.box[1];
        ctx.strokeRect(annotation.box[0], annotation.box[1], box_width, box_height);

        // Draw the number
        ctx.font = '20px Arial';
        ctx.fillStyle = colorPicker.value;
        ctx.fillText(index + 1, annotation.box[0], annotation.box[1] - 5);

        // Add caption to the list
        const captionItem = document.createElement('div');
        captionItem.classList.add('caption-item');
        captionItem.textContent = `${index + 1}. ${annotation.label}`;
        captionItem.addEventListener('mouseover', () => {
            highlightedAnnotation = index;
            redraw();
        });
        captionItem.addEventListener('mouseout', () => {
            highlightedAnnotation = null;
            redraw();
        });
        captionsDiv.appendChild(captionItem);
    });
}
