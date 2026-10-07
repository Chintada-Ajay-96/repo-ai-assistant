export interface WidgetProps {
  title: string;
}

export const Widget = ({ title }: WidgetProps) => {
  return <div className="widget">{title}</div>;
};
