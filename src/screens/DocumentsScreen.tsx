import { Screen } from '../components/ui';
import DocumentKnowledge from './DocumentKnowledge';
export default function DocumentsScreen() {
  return (
    <Screen title="프로젝트 자료" back>
      <DocumentKnowledge />
    </Screen>
  );
}
