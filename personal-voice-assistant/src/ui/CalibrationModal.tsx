import type { ClapController } from '../clap/useClapController';
import { CalibrationWizard } from './CalibrationWizard';
import { Modal } from './Modal';

export function CalibrationModal({ clap, onClose, onManual }: { clap: ClapController; onClose: () => void; onManual: () => void }) {
  const close = () => {
    clap.calib.cancel();
    onClose();
  };
  return (
    <Modal title="キャリブレーション" en="CALIBRATION" onClose={close}>
      <CalibrationWizard
        calib={clap.calib}
        onUse={(which) => {
          clap.useCalibrationResult(which);
          onClose();
          if (which === 'manual') onManual();
        }}
      />
    </Modal>
  );
}
