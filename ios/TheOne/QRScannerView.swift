import SwiftUI
import AVFoundation

struct PairHubSheet: View {
    @ObservedObject var hub: HubClient
    @Environment(\.dismiss) private var dismiss
    @State private var manualURL: String = ""
    @State private var manualToken: String = ""
    @State private var showCamera: Bool = false

    var body: some View {
        NavigationStack {
            ZStack {
                TheOneTheme.obsidianBg.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 18) {
                        VStack(spacing: 8) {
                            TheOneLogoView(size: 46)
                            Text("Pair iPhone with TheOne Hub")
                                .font(.headline)
                                .foregroundStyle(.white)
                            Text("Open TheOne on your Mac → Advanced → Pair iPhone / iPad, then scan the QR code or paste the pairing URL.")
                                .font(.caption)
                                .foregroundStyle(TheOneTheme.mutedText)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.top, 8)

                        if showCamera {
                            CameraQRScannerRepresentable { scanned in
                                if hub.applyPairing(rawInput: scanned) {
                                    dismiss()
                                }
                            }
                            .frame(height: 260)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .overlay(
                                RoundedRectangle(cornerRadius: 16)
                                    .stroke(TheOneTheme.goldMain.opacity(0.6), lineWidth: 1.5)
                            )
                        } else {
                            Button {
                                showCamera = true
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "qrcode.viewfinder")
                                        .font(.system(size: 18, weight: .semibold))
                                    Text("Scan Pairing QR Code")
                                        .font(.subheadline.weight(.bold))
                                }
                                .foregroundStyle(.black)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(TheOneTheme.goldGradient)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                            }
                        }

                        VStack(alignment: .leading, spacing: 12) {
                            Text("MANUAL / TAILSCALE URL")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(TheOneTheme.goldMain)

                            TextField("http://192.168.1.42:4747/?token=...", text: $manualURL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .font(.system(size: 13, design: .monospaced))
                                .padding(12)
                                .background(TheOneTheme.surfaceElevated)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(TheOneTheme.borderSubtle))

                            TextField("Optional Bearer Token (if not in URL)", text: $manualToken)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .font(.system(size: 13, design: .monospaced))
                                .padding(12)
                                .background(TheOneTheme.surfaceElevated)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(TheOneTheme.borderSubtle))

                            Button {
                                var combined = manualURL.trimmingCharacters(in: .whitespacesAndNewlines)
                                let tok = manualToken.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !tok.isEmpty && !combined.contains("token=") {
                                    combined += (combined.contains("?") ? "&" : "?") + "token=\(tok)"
                                }
                                if hub.applyPairing(rawInput: combined) {
                                    dismiss()
                                }
                            } label: {
                                Text("Connect to Hub")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(TheOneTheme.surfaceElevated)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(TheOneTheme.goldMain.opacity(0.45)))
                            }
                            .disabled(manualURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        .padding(16)
                        .background(TheOneTheme.surfaceCard)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(TheOneTheme.borderSubtle))

                        Button {
                            if hub.applyPairing(rawInput: "http://127.0.0.1:4747") {
                                dismiss()
                            }
                        } label: {
                            Text("Reset to Simulator Localhost (127.0.0.1:4747)")
                                .font(.caption)
                                .foregroundStyle(TheOneTheme.mutedText)
                        }
                    }
                    .padding()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(TheOneTheme.goldMain)
                }
            }
            .onAppear {
                manualURL = hub.pairing.baseURL
                manualToken = hub.pairing.token
            }
        }
    }
}

struct CameraQRScannerRepresentable: UIViewControllerRepresentable {
    var onFound: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let vc = QRScannerController()
        vc.onFound = onFound
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
}

final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onFound: ((String) -> Void)?
    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmit = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            showFallbackLabel("Camera unavailable on Simulator.\nPaste the pairing URL below.")
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.layer.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.previewLayer = preview
        self.captureSession = session

        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession?.stopRunning()
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didEmit,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let code = obj.stringValue, !code.isEmpty else { return }
        didEmit = true
        captureSession?.stopRunning()
        onFound?(code)
    }

    private func showFallbackLabel(_ text: String) {
        let label = UILabel()
        label.text = text
        label.textColor = UIColor.lightGray
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16)
        ])
    }
}
