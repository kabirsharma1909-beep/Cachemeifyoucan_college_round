# FreeHand Browser 🖐️

### Voice and Webcam-Based Hands-Free Browsing

FreeHand Browser is an accessibility-focused project designed to make web browsing easier using voice commands and hand gestures. It aims to help people with motor impairments, temporary injuries, and users who prefer hands-free interaction.

## ✨ Features

- **Voice Commands:** Navigate and interact with the browser using voice.
- **Hand Gesture Recognition:** Use webcam-based hand tracking powered by MediaPipe.
- **Web Navigation:** Perform supported actions such as searching, scrolling, going back, and going forward.
- **Accessibility-Focused Design:** Explore hands-free interaction to make browsing more inclusive.
- **Local-First Prototype:** Run the application locally during development.

## 🛠️ Technologies Used

- React / Vite
- JavaScript
- Node.js
- MediaPipe
- Web Speech API
- Gemini API (optional, for natural-language command parsing)

## 🚀 Getting Started

### Prerequisites

- Node.js 22 or newer
- npm
- A modern web browser
- Webcam and microphone permissions for supported features

### Installation

1. Clone this repository:

   ```bash
   git clone YOUR_REPOSITORY_URL
   ```

2. Open the project folder:

   ```bash
   cd YOUR_PROJECT_FOLDER
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. If required, copy `.env.example` to `.env` and configure your `GEMINI_API_KEY`.

5. Start the development server:

   ```bash
   npm run dev
   ```

6. Open the local URL displayed in your terminal, usually `http://localhost:5173`.

## 🎯 Project Goal

To explore accessible, hands-free web interaction using commonly available hardware, reducing dependence on traditional mouse and keyboard controls.

## 🔮 Future Scope

- Improved gesture recognition and customizable gestures.
- Predictive targeting and visual feedback.
- Sign-language integration to support more inclusive interaction.
- Expanded browser automation and desktop control.
- Better compatibility with assistive technologies.

## ⚠️ Current Status

This project is a prototype under development. Features and supported commands may vary. Check the implementation before relying on any feature for accessibility-critical tasks.

## 👥 Contributors

Developed as a collaborative project for a college hackathon.

---

**FreeHand Browser — Browse beyond your hands.**
