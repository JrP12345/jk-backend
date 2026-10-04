# Video and imaging provider setup

The selected providers are **self-hosted Jitsi Meet** and **Orthanc with the DICOMweb plugin**. No public meeting server or public imaging demo is used by default. These changes provide application adapters; they do not deploy either service or upload patient studies.

## Video: Jitsi Meet

1. Deploy Jitsi Meet on an HTTPS host controlled by the platform or clinic. Use Jitsi's [self-hosting instructions](https://jitsi.github.io/handbook/docs/devops-guide/). Configure authenticated room creation and the guest/lobby policy before inviting patients.
2. Set backend `TELECONSULTATION_BASE_URL=https://meet.your-domain.example` to the host's meeting URL prefix, without credentials, query parameters or fragments. Restart the backend after changing configuration. No frontend environment variable or third-party script is needed.
3. Create a consultation for a test appointment. New session rooms use an unpredictable UUID and contain no patient name or identifier. Open the consultation workspace, then **Join video meeting**. Share **Copy meeting link** only with the invited participant. Provider authentication and guest admission take place in Jitsi.
4. Verify two participants can join, audio/video work, screen sharing works, and the host can restrict guest admission. The app does not infer participation or call duration from opening a tab. Closing/completing the app's clinical session does not close an external meeting tab.

Existing sessions keep their stored meeting URLs. Legacy relative workspace links are shown as unavailable; configuring the host does not migrate those records. Test with a newly created appointment/session. No migration was run.

Jitsi's [integration guide](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe/) documents custom meeting hosts. This implementation opens the configured room in its own tab so the provider owns camera/microphone controls; the clinical workspace remains available alongside it.

## Imaging: Orthanc DICOMweb

1. Deploy Orthanc privately and enable its [DICOMweb plugin](https://orthanc.uclouvain.be/book/plugins/dicomweb.html). Configure access authentication and network/TLS restrictions. PACS credentials must remain on the backend.
2. Set:

   ```dotenv
   PACS_DICOMWEB_BASE_URL=https://pacs.your-domain.example/dicom-web
   PACS_DICOMWEB_USERNAME=<server-service-user>
   PACS_DICOMWEB_PASSWORD=<server-service-password>
   # Alternatively use PACS_DICOMWEB_TOKEN for a bearer-authenticated gateway.
   ```

   Set the existing `PACS_BASE_URL` to the browser-facing PACS viewer URL if one is available. It is distinct from the DICOMweb API root. Per-record `dicomWebUrl` values are external viewer links and are never server fetch targets.

3. Match each clinical record's `studyInstanceUid` to the actual DICOM StudyInstanceUID held in Orthanc. The current study creation flow generates an order UID; it does **not** send a modality worklist, ingest scanner files, or import a scanner-assigned UID. Configure the acquisition/worklist bridge to retain that UID before claiming end-to-end acquisition. No patient upload or UID migration is performed by this adapter.
4. Verify the DICOMweb root supports QIDO `studies/{StudyInstanceUID}/instances` (including SeriesInstanceUID, SOPInstanceUID, NumberOfFrames and InstanceNumber), and WADO `studies/{study}/series/{series}/instances/{instance}/frames/{frame}/rendered` with `Accept: image/png`.

The authenticated app endpoint is `GET /api/radiology/studies/:id/preview`. With no query it returns a manifest; with `seriesUid`, `instanceUid`, and `frame` it returns PNG. Existing imaging staff permissions and clinic access are checked before contacting PACS. Frame identifiers must appear in that study's manifest. Responses use `private, no-store`; PACS redirects are rejected; requests time out after 15 seconds; each response is limited to 8 MiB. The preview shows up to 500 instances and 10,000 frames per instance. Larger studies require the full PACS viewer.

The frontend renders actual images, navigates instances/frames, and applies zoom, rotation and inversion to the displayed preview. It releases object URLs on changes/close and discards stale responses. This is a rendered preview, not a validated diagnostic workstation: window-level manipulation, measurements, volumetric reconstruction and acquisition integration remain in the clinical PACS.

## Activation checks

- Run the focused imaging/teleconsultation tests and both repositories' relevant type/build checks.
- Confirm unauthenticated users, patients without staff permissions, and administrators of another clinic cannot retrieve a study preview.
- Exercise missing studies, empty manifests, PACS authentication failure, timeout and frame retry with test data.
- Validate both meeting participants and a real scanner study on the configured private services before production activation.

Local tests mock provider transport and use disposable MongoDB. They do not verify live provider availability, guest admission or scanner acquisition.
