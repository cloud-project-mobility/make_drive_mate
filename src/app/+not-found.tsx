import { router } from 'expo-router';
import { Screen, Notice, Button } from '../components/ui';
export default function NotFound() {
  return (
    <Screen title="길을 다시 찾아볼까요?">
      <Notice title="이 화면을 찾을 수 없어요." body="내 차량에서 이어서 이용해 주세요." />
      <Button title="내 차량으로 돌아가기" onPress={() => router.replace('/')} />
    </Screen>
  );
}
